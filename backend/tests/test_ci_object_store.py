"""CI's object store, and the shape of failure that keeps taking it away.

Docker Hub's minio/minio repository is withdrawn. An authenticated pull token
gets 401 there where library/redis gets 200, so this is the repository going
away rather than a rate limit, and `docker pull minio/minio` fails for everyone.
Both jobs that need an object store died at container start, before a single
step ran, and main went red on a commit that had passed CI hours earlier.

That is the second upstream withdrawal to break this same file — ci.yml already
carried a comment about moving off bitnami/minio for the same reason — which is
why the rules below are asserted rather than left in a comment.

WHY THE FIX COULD NOT JUST BE A NEW TAG

A `services:` container is given no command. That only ever worked because
minio/minio:edge-cicd defaulted to `minio server /data`. quay.io is MinIO's own
other registry, but nothing there is a drop-in: `latest`, `latest-cicd` and
every RELEASE tag default to Cmd ["minio"], which prints its help and exits 0 —
a service container that never becomes healthy. MINIO_VOLUMES does not supply
the missing subcommand either. Starting the container in a step is the only form
that can pass `server /data`.

So there are four rules, and each one is a way the fix could be quietly undone:
MinIO must not go back under `services:`, it must be started with the server
subcommand, it must come from quay, and it must be pinned to a dated RELEASE
rather than a floating tag — a floating tag is exactly what disappeared.

The fifth test is the one that would have caught an older bug in this file: the
backend job carried S3 credentials and real upload tests for a long time with no
object store at all, so those tests could only ever fail.
"""

import pathlib
import re

import pytest
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
COMPOSE_FILES = (
    ROOT / "infra" / "docker-compose.yml",
    ROOT / "infra" / "docker-compose.prod.yml",
)

# MinIO stamps releases with a UTC timestamp and never reuses one, so a tag in
# this shape is a fixed artefact. `latest`, `latest-cicd` and `edge-cicd` are not.
_DATED_RELEASE = re.compile(r"^RELEASE\.\d{4}-\d{2}-\d{2}T[\d-]+Z(?:[.-][\w.-]+)?$")

# A registry/name:tag token. Matched against script lines only after comments are
# dropped, so the prose above `docker run` does not read as a reference.
_IMAGE_TOKEN = re.compile(r"(?<![\w./-])((?:[\w.-]+(?::\d+)?/)*minio[\w.-]*:[\w.+-]+)")


def _workflow() -> dict:
    """ci.yml, parsed.

    Structure is asserted against this rather than against the raw text, so
    reindenting or reordering the file cannot fail a test for the wrong reason.
    """
    return yaml.safe_load(WORKFLOW.read_text())


def _uncommented(text: str) -> str:
    """Drop whole-line comments before scanning for image references.

    The comments in ci.yml name minio/minio:edge-cicd deliberately, to record
    what was withdrawn and why. Scanning the raw text would read that prose as a
    reference and fail the quay rule on the explanation for the quay rule.
    """
    return "\n".join(line for line in text.splitlines() if not line.strip().startswith("#"))


def _minio_image_references() -> list[tuple[str, str]]:
    """Every (source, image) MinIO reference the repository would actually pull."""
    found: list[tuple[str, str]] = []
    for image in _IMAGE_TOKEN.findall(_uncommented(WORKFLOW.read_text())):
        found.append((WORKFLOW.name, image))
    for path in COMPOSE_FILES:
        for service in (yaml.safe_load(path.read_text()).get("services") or {}).values():
            image = (service or {}).get("image", "")
            if "minio" in image:
                found.append((path.name, image))
    return found


def _start_steps() -> dict[str, str]:
    """job name -> the shell of its MinIO start step, for jobs that have one."""
    steps = {}
    for name, job in _workflow()["jobs"].items():
        for step in job.get("steps") or []:
            if "minio" in (step.get("name") or "").lower():
                steps[name] = step.get("run", "")
    return steps


def test_minio_is_never_a_service_container():
    """The service form cannot pass a command, and no available image defaults
    to one that serves. Putting it back is a green diff and a dead job."""
    offenders = [
        (job, service)
        for job, spec in _workflow()["jobs"].items()
        for service, cfg in (spec.get("services") or {}).items()
        if "minio" in (cfg or {}).get("image", "")
    ]
    assert offenders == [], (
        f"MinIO is declared as a service container in {offenders}. That form supplies no "
        "command, and every published MinIO image defaults to Cmd ['minio'], which prints "
        "help and exits — the container is never healthy."
    )


def test_every_job_expecting_an_object_store_starts_one():
    """Credentials are not an object store.

    The backend job carried RXHIVE_S3_ENDPOINT and real upload tests long before
    anything served them, so those tests could only ever fail — and it went
    unnoticed because lint failed earlier and the job never reached them. Tying
    the two sets together is what makes that state unrepresentable.
    """
    expecting = {
        name for name, job in _workflow()["jobs"].items() if "RXHIVE_S3_ENDPOINT" in yaml.safe_dump(job)
    }
    assert expecting, "no job references RXHIVE_S3_ENDPOINT — has the variable been renamed?"
    assert expecting == set(_start_steps()), (
        f"jobs expecting an object store: {sorted(expecting)}; jobs starting one: "
        f"{sorted(_start_steps())}. A job with S3 credentials and no object store has "
        "upload tests that can only fail."
    )


@pytest.mark.parametrize("job", sorted(_start_steps()))
def test_the_start_step_passes_the_server_subcommand(job: str):
    """The subcommand is the entire reason this is a step and not a service.

    Every published MinIO image defaults to Cmd ["minio"], which prints its help
    and exits 0. Dropping `server /data` leaves a step that succeeds, a container
    that is already gone, and a failure that surfaces much later as a refused
    connection in something unrelated.
    """
    assert re.search(r"\bserver\s+/data\b", _start_steps()[job]), (
        f"{job} starts MinIO without `server /data`. The image's default command is "
        "`minio`, which prints its help and exits 0, so the job fails later and "
        "somewhere less obvious."
    )


@pytest.mark.parametrize("job", sorted(_start_steps()))
def test_the_start_step_waits_for_health(job: str):
    """Without a wait the step succeeds instantly and the failure surfaces as an
    unrelated connection error in whatever runs next."""
    shell = _start_steps()[job]
    assert "/minio/health/live" in shell, f"{job} does not poll MinIO's health endpoint"
    assert re.search(r"\bexit 1\b", shell), f"{job} never fails when MinIO does not come up"


@pytest.mark.parametrize(("source", "image"), _minio_image_references())
def test_minio_images_come_from_quay(source: str, image: str):
    """Docker Hub's minio/minio cannot be pulled by anyone any more.

    An authenticated pull token gets 401 there where library/redis gets 200, so a
    reference that goes back is not slow or rate-limited — it is dead, and it
    fails at container start before any step of the job runs.
    """
    assert image.startswith("quay.io/"), (
        f"{source} pulls {image}. Docker Hub's minio/minio is withdrawn — that reference "
        "cannot be pulled by anyone."
    )


@pytest.mark.parametrize(("source", "image"), _minio_image_references())
def test_minio_images_are_pinned_to_a_dated_release(source: str, image: str):
    """A floating tag is what disappeared.

    `latest`, `latest-cicd` and `edge-cicd` all move or vanish underneath you.
    MinIO stamps a RELEASE with a UTC timestamp and never reuses it, so a dated
    tag is a fixed artefact that cannot change meaning between two runs of the
    same commit.
    """
    tag = image.rpartition(":")[2]
    assert _DATED_RELEASE.match(tag), (
        f"{source} pins MinIO at {tag!r}. A floating tag is what disappeared; use a dated "
        "RELEASE, which MinIO never reuses."
    )


def test_there_is_at_least_one_reference_to_check():
    """The parametrized tests above vacuously pass on an empty list."""
    assert len(_minio_image_references()) >= 3, _minio_image_references()

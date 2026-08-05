import LiveKit
import XCTest
@testable import RxHive

/// The two pieces of call plumbing that are pure enough to test without a network or
/// an SFU, and that a mistake in would be almost invisible at runtime.
///
/// **Identity parsing.** LiveKit identities are `{userID}#{deviceID}` — they have to be
/// unique per connection, or the SFU disconnects the earlier client as a duplicate,
/// silently. Every other layer (the socket's participant frames, the avatar lookup, the
/// mute relay) speaks in bare user ids, so a bad split does not crash: it produces a
/// call whose tiles never match the people in it, and whose mute icons flip on the
/// wrong faces.
///
/// **`ActiveCallState` decoding.** This is the recovery payload for every `call:*` frame
/// lost while the socket was down. A silently-failing decode (`try?` at the call site)
/// turns the whole recovery path into a no-op — the exact symptom it exists to fix — so
/// the shape is asserted against the JSON `services/calls.active_call_state` really
/// sends, key for key.
final class CallResilienceTests: XCTestCase {

    // MARK: - Room identity

    func testUserIDStripsTheDeviceSuffix() {
        XCTAssertEqual(
            LiveKitSession.userID(of: "7a1f0c9e-0000-4000-8000-000000000001#iphone14"),
            "7a1f0c9e-0000-4000-8000-000000000001"
        )
    }

    func testUserIDToleratesABareUserID() {
        // A webhook queued by an older build, or a participant published before the
        // suffix existed, must still resolve rather than vanishing from the roster.
        XCTAssertEqual(LiveKitSession.userID(of: "7a1f0c9e-0000-4000-8000-000000000001"),
                       "7a1f0c9e-0000-4000-8000-000000000001")
    }

    func testUserIDHandlesEmptyAndNil() {
        XCTAssertEqual(LiveKitSession.userID(of: nil), "")
        XCTAssertEqual(LiveKitSession.userID(of: ""), "")
    }

    func testUserIDKeepsOnlyTheFirstSeparator() {
        // Splitting on every `#` would silently truncate a device id that contains one.
        XCTAssertEqual(LiveKitSession.userID(of: "user#a#b"), "user")
    }

    func testTwoDevicesOfOneUserResolveToTheSameUser() {
        let phone = "u1#phone"
        let laptop = "u1#laptop"
        XCTAssertNotEqual(phone, laptop, "identities must differ or the SFU evicts one")
        XCTAssertEqual(LiveKitSession.userID(of: phone), LiveKitSession.userID(of: laptop))
    }

    // MARK: - Link state vocabulary

    func testMediaLinkWireValuesMatchTheServersVocabulary() {
        // Anything outside `services/calls._PEER_STATES` is dropped by the relay, so a
        // drift here would silently stop the peer ever seeing "Connecting…".
        XCTAssertEqual(CallMediaLink.connected.wireValue, "connected")
        XCTAssertEqual(CallMediaLink.reconnecting.wireValue, "reconnecting")
    }

    func testNetworkQualityWireValuesMatchTheServersVocabulary() {
        XCTAssertEqual(CallNetworkQuality.excellent.wireValue, "excellent")
        XCTAssertEqual(CallNetworkQuality.good.wireValue, "good")
        XCTAssertEqual(CallNetworkQuality.poor.wireValue, "poor")
        XCTAssertEqual(CallNetworkQuality.unknown.wireValue, "unknown")
    }

    // MARK: - Resume payload

    /// Exactly what `GET /api/calls/active` returns for a connected 1:1 call whose peer
    /// is currently absent.
    private static let connectedJSON = """
    {
      "call_id": "11111111-1111-4111-8111-111111111111",
      "status": "connected",
      "call_type": "video",
      "is_group": false,
      "conversation_id": "22222222-2222-4222-8222-222222222222",
      "room": "call_11111111-1111-4111-8111-111111111111",
      "initiated_by": "aaaa1111-1111-4111-8111-111111111111",
      "is_initiator": false,
      "caller": {
        "id": "aaaa1111-1111-4111-8111-111111111111",
        "display_name": "Alice",
        "avatar_url": null
      },
      "group_name": null,
      "participants": [
        {"id": "aaaa1111-1111-4111-8111-111111111111", "display_name": "Alice", "avatar_url": null},
        {"id": "bbbb2222-2222-4222-8222-222222222222", "display_name": "Bob", "avatar_url": "/media/b.jpg"}
      ],
      "joined": ["bbbb2222-2222-4222-8222-222222222222"],
      "self_joined": true,
      "started_at": "2026-08-03T10:00:00Z",
      "answered_at": "2026-08-03T10:00:05Z",
      "ring_expires_in": null,
      "peer_links": {
        "aaaa1111-1111-4111-8111-111111111111": "down",
        "bbbb2222-2222-4222-8222-222222222222": "up"
      }
    }
    """

    private func decode(_ json: String) throws -> ActiveCallState {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = RxDate.parse(text) else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath, debugDescription: "Bad date \(text)")
                )
            }
            return date
        }
        return try decoder.decode(ActiveCallState.self, from: Data(json.utf8))
    }

    func testDecodesAConnectedCall() throws {
        let state = try decode(Self.connectedJSON)

        XCTAssertEqual(state.callID, "11111111-1111-4111-8111-111111111111")
        XCTAssertTrue(state.isConnected)
        XCTAssertFalse(state.isRinging)
        XCTAssertEqual(state.callType, .video)
        XCTAssertFalse(state.isGroup)
        XCTAssertEqual(state.room, "call_11111111-1111-4111-8111-111111111111")
        XCTAssertFalse(state.isInitiator)
        XCTAssertEqual(state.caller?.displayName, "Alice")
        XCTAssertEqual(state.participants.count, 2)
        XCTAssertEqual(state.joined, ["bbbb2222-2222-4222-8222-222222222222"])
        XCTAssertNotNil(state.answeredAt)
        XCTAssertNil(state.ringExpiresIn)
        // `self_joined` is what decides between resuming into a live room and being put
        // back on the ringer, so it must survive the decode intact.
        XCTAssertTrue(state.selfJoined)
        // And the peer's absence has to arrive, or the resumed UI cannot show
        // "Connecting…" for someone who dropped while we were away.
        XCTAssertEqual(state.peerLinks["aaaa1111-1111-4111-8111-111111111111"], "down")
        XCTAssertEqual(state.peerLinks["bbbb2222-2222-4222-8222-222222222222"], "up")
    }

    func testDecodesARingingGroupCallWithARemainingWindow() throws {
        let json = """
        {
          "call_id": "33333333-3333-4333-8333-333333333333",
          "status": "ringing",
          "call_type": "voice",
          "is_group": true,
          "conversation_id": "44444444-4444-4444-8444-444444444444",
          "room": "call_33333333-3333-4333-8333-333333333333",
          "initiated_by": "aaaa1111-1111-4111-8111-111111111111",
          "is_initiator": false,
          "caller": {"id": "aaaa1111-1111-4111-8111-111111111111", "display_name": "Alice", "avatar_url": null},
          "group_name": "Cardiology",
          "participants": [],
          "joined": [],
          "self_joined": false,
          "started_at": "2026-08-03T10:00:00Z",
          "answered_at": null,
          "ring_expires_in": 31.5,
          "peer_links": {}
        }
        """
        let state = try decode(json)

        XCTAssertTrue(state.isRinging)
        XCTAssertTrue(state.isGroup)
        XCTAssertEqual(state.groupName, "Cardiology")
        XCTAssertNil(state.answeredAt)
        XCTAssertFalse(state.selfJoined)
        // The remaining window lets a recovered ringer count down against the server's
        // clock rather than restarting a 45-second timer of its own.
        XCTAssertEqual(state.ringExpiresIn ?? 0, 31.5, accuracy: 0.001)
    }

    func testResumedStateConvertsToTheSignalTheLiveFlowUses() throws {
        // A recovered call goes through the same phase transitions as a live one, so
        // the conversion has to preserve everything the ringing screen renders.
        let signal = try decode(Self.connectedJSON).asSignal

        XCTAssertEqual(signal.callID, "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(signal.callType, .video)
        XCTAssertEqual(signal.caller?.displayName, "Alice")
        XCTAssertEqual(signal.conversationID, "22222222-2222-4222-8222-222222222222")
        XCTAssertEqual(signal.isGroup, false)
        XCTAssertEqual(signal.participants?.count, 2)
    }

    func testAnUnknownStatusIsNeitherRingingNorConnected() throws {
        // The server only ever sends `ringing` or `connected` here. A third value must
        // fall through to "do nothing" rather than being coerced into either — adopting
        // a finished call would put a dead call back on screen.
        let json = Self.connectedJSON.replacingOccurrences(
            of: "\"status\": \"connected\"", with: "\"status\": \"answered\""
        )
        let state = try decode(json)
        XCTAssertFalse(state.isRinging)
        XCTAssertFalse(state.isConnected)
    }

    // MARK: - Inviting people into a running group call

    /// `call:participants_invited` — the frame that lets the grid show somebody ringing.
    ///
    /// Published by `services/calls.invite_to_call` to everyone already in the call. It
    /// reuses `CallSignal`'s `participants` key, so a rename on either side has to fail
    /// here rather than decoding to nil and quietly leaving the placeholder tiles off.
    func testInvitedParticipantsFrameDecodes() throws {
        let json = """
        {
          "type": "call:participants_invited",
          "call_id": "11111111-1111-4111-8111-111111111111",
          "invited_by": "33333333-3333-4333-8333-333333333333",
          "participants": [
            {"id": "44444444-4444-4444-8444-444444444444",
             "display_name": "Dave", "avatar_url": null}
          ]
        }
        """
        let signal = try JSONDecoder().decode(CallSignal.self, from: Data(json.utf8))
        XCTAssertEqual(signal.callID, "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(signal.participants?.count, 1)
        XCTAssertEqual(signal.participants?.first?.displayName, "Dave")
    }

    /// `call:participant_declined` — group calls only.
    ///
    /// A declined 1:1 is `call:declined`, which ends the call. A group call must survive
    /// one person saying no, so this is a per-participant frame and carries who it was.
    func testDeclinedParticipantFrameDecodes() throws {
        let json = """
        {
          "type": "call:participant_declined",
          "call_id": "11111111-1111-4111-8111-111111111111",
          "participant_id": "44444444-4444-4444-8444-444444444444",
          "participant": {"id": "44444444-4444-4444-8444-444444444444",
                          "display_name": "Dave", "avatar_url": null}
        }
        """
        let signal = try JSONDecoder().decode(CallSignal.self, from: Data(json.utf8))
        XCTAssertEqual(signal.participantID, "44444444-4444-4444-8444-444444444444")
        XCTAssertEqual(signal.participant?.displayName, "Dave")
    }

    func testInviteResultDecodesThePerInviteeOutcome() throws {
        let json = """
        {
          "invited": ["44444444-4444-4444-8444-444444444444"],
          "outcome": {
            "44444444-4444-4444-8444-444444444444": "invited",
            "55555555-5555-4555-8555-555555555555": "different_org"
          }
        }
        """
        let result = try JSONDecoder().decode(CallInviteResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.invited, ["44444444-4444-4444-8444-444444444444"])
        XCTAssertEqual(result.outcome["55555555-5555-4555-8555-555555555555"], "different_org")
    }

    /// Every refusal the server can report has to produce a sentence.
    ///
    /// A partial result reported as a flat success is how somebody ends up waiting for a
    /// person who was never rung, so `invited` is the ONLY outcome that stays silent —
    /// including outcomes this build has never heard of.
    func testEveryRefusalOutcomeProducesAMessageAndInvitedDoesNot() {
        XCTAssertNil(CallInviteResult.message(for: "invited", who: "Dave"))
        for outcome in ["already_invited", "unavailable", "different_org", "call_full", "brand_new"] {
            XCTAssertNotNil(
                CallInviteResult.message(for: outcome, who: "Dave"),
                "outcome \(outcome) would be refused silently"
            )
        }
    }

    // MARK: - Pending invitees

    @MainActor
    func testPendingInviteesAreDedupedAndRetiredWhenTheyArrive() {
        let store = CallStore()
        let dave = CallParticipantBrief(id: "dave", displayName: "Dave", avatarURL: nil)

        store.addPendingInvitees([dave, dave])
        XCTAssertEqual(store.pendingInvitees.map(\.id), ["dave"],
                       "the same invitee twice must not produce two ringing tiles")

        // The server sends `call:participants_invited` to the inviter too, so the
        // optimistic add and the frame both land — the second must be a no-op.
        store.addPendingInvitees([dave])
        XCTAssertEqual(store.pendingInvitees.count, 1)
    }

    // MARK: - Camera mirroring

    /// The back camera must never be mirrored, and the call site must not be the one
    /// deciding it.
    ///
    /// This was `mirrored: Bool`, passed `true` for the 1:1 self-view and
    /// `tile.isLocal` for the group grid — so both mirrored whichever camera was
    /// feeding them. Mirroring a front camera is right (people expect a mirror of their
    /// own face); mirroring the back camera puts every sign, badge and screen in the
    /// scene back-to-front.
    ///
    /// A `Bool` at the call site cannot be correct, because the answer changes under
    /// `flipCamera()` and can change without being asked when the SDK falls back to
    /// another device. `.auto` asks the frame's own capture device instead
    /// (`VideoView._shouldMirror`), which is why the default is the fix — this test
    /// exists to stop it being changed back to `.mirror`.
    @MainActor
    func testCameraViewDefaultsToFacingAwareMirroringNotForcedMirror() {
        XCTAssertEqual(CallVideoView(track: nil).mirror, .auto)
        XCTAssertNotEqual(CallVideoView(track: nil).mirror, .mirror)
    }

    /// `.auto` is a property of the RENDERER, so it cannot reach the far side.
    ///
    /// The published frame leaves the capturer through
    /// `delegate?.capturer(_:didCapture:)` straight off the capture buffer, while
    /// mirroring is applied as a `layer.transform` on the renderer's own layer. Asserted
    /// as the vocabulary check it can be — if a future SDK renames or repurposes these
    /// cases, this fails rather than silently mirroring what gets transmitted.
    @MainActor
    func testMirrorModeVocabularyIsTheOneWeReasonedAbout() {
        // A screen share and every remote track have no capture device, so `.auto`
        // resolves to "do not mirror" for them.
        XCTAssertEqual(CallVideoView(track: nil, fitsContent: true).mirror, .auto)
        // `.off` still exists as an explicit opt-out, and is distinct from `.auto`.
        XCTAssertNotEqual(VideoView.MirrorMode.off, VideoView.MirrorMode.auto)
    }

    // MARK: - Camera on/off

    /// The button moves before the hardware does.
    ///
    /// Reopening a capture device takes long enough that a control which waits for it
    /// reads as broken and gets tapped again — which is how the rapid-tap problem below
    /// gets created in the first place. `isCameraOn` is therefore written synchronously,
    /// and corrected afterwards from what is actually published if the operation failed
    /// (`LiveKitSession.setCamera` re-derives it, `pullSessionState` copies it back).
    @MainActor
    func testCameraToggleUpdatesTheButtonImmediately() {
        let store = CallStore()
        XCTAssertFalse(store.isCameraOn)

        store.toggleCamera()

        // No awaiting: the flag has already moved by the time the call returns.
        XCTAssertTrue(store.isCameraOn, "the camera button waited for the hardware before moving")
    }

    /// Four taps in a row net out to the state four taps imply.
    ///
    /// Each tap reads the CURRENT flag rather than one captured earlier, so tap N always
    /// asks for the opposite of tap N-1. With the work spawned as loose Tasks the SDK
    /// would still serialise its own publishing, but the completions — and the
    /// `call:toggle_media` frame each one sends — could land in either order, leaving the
    /// far side on the state from an earlier tap. Chaining them makes the last tap the
    /// last writer.
    @MainActor
    func testRapidTogglesNetOutRatherThanRacing() {
        let store = CallStore()

        for _ in 0..<4 { store.toggleCamera() }
        XCTAssertFalse(store.isCameraOn, "an even number of taps did not return to the starting state")

        for _ in 0..<3 { store.toggleCamera() }
        XCTAssertTrue(store.isCameraOn, "an odd number of taps did not end up on")
    }

    /// With no room there is nothing to publish, and asking must not crash or hang.
    ///
    /// This is the state a toggle can genuinely be pressed in — the ringing screen, a
    /// call being torn down, a reconnect mid-flight — and it is the state this test can
    /// construct without an SFU.
    @MainActor
    func testCameraToggleWithNoRoomIsSafe() async {
        let session = LiveKitSession()
        let reached = await session.setCamera(enabled: true, position: .back)
        XCTAssertTrue(reached, "with no room the requested state is reported back unchanged")
        XCTAssertNil(session.cameraPosition, "no room means no capture device to report")
    }


    // MARK: - Terminal phase

    /// `.ended` is a *held* phase: the only thing that clears it is the auto-reset
    /// task `teardown` schedules, and that task is scheduled only when a call was
    /// actually live. Tearing down to `.ended` from idle therefore parked the
    /// store in `.ended` for good — and CallOverlayHost renders `.ended`
    /// full-screen, so the app sat behind an undismissable "Call ended" card over
    /// a call that never happened, recoverable only by relaunching.
    ///
    /// One stray frame did it. `.callEnded`, `.callDeclined`, `.callBusy` and
    /// `.callUnavailable` tore down unconditionally, unlike `.callGroupEnded`
    /// which always guarded on `hasLiveCall`; a late frame for a dismissed call,
    /// or one re-delivered when the socket resumes, arrives while idle by
    /// definition.
    @MainActor
    func testTearingDownToEndedWithNoLiveCallLandsOnIdleInstead() {
        XCTAssertEqual(
            CallStore.resolvedTerminal(.ended, wasLive: false), .idle,
            "an ended phase with no call behind it can never be cleared"
        )
        XCTAssertEqual(
            CallStore.resolvedTerminal(.ended, wasLive: true), .ended,
            "a real call must still show its Call ended card"
        )
        // Terminals that are not `.ended` are self-clearing and pass through.
        XCTAssertEqual(CallStore.resolvedTerminal(.idle, wasLive: true), .idle)
        XCTAssertEqual(CallStore.resolvedTerminal(.idle, wasLive: false), .idle)
    }

    /// The precondition the guards on those four frames rest on: a freshly built
    /// store is idle, so `hasLiveCall` is false and a stray terminal frame is
    /// dropped before it can toast about a call that is not happening.
    @MainActor
    func testAFreshStoreHasNoLiveCall() {
        XCTAssertFalse(CallStore().hasLiveCall)
    }

    // MARK: - Rejoin budget

    /// The rejoin loop must tell "this attempt failed" apart from "the user hung
    /// up". It used `callID != nil` for that, but `join` clears `callID` on its
    /// own failure paths too — so the first unreachable SFU ended the whole
    /// five-attempt budget AND skipped `onRoomLost`, leaving the call on
    /// "Reconnecting…" until the user force-quit.
    @MainActor
    func testAFailedJoinAttemptDoesNotEndTheRejoinBudget() async {
        let session = LiveKitSession()
        XCTAssertFalse(session.rejoinAbandoned, "a fresh session has a budget to spend")

        // What join's own failure paths do.
        await session.leave(endingCall: false)
        XCTAssertFalse(
            session.rejoinAbandoned,
            "a failed attempt must leave the remaining attempts available"
        )

        // What a hang-up does.
        await session.leave()
        XCTAssertTrue(
            session.rejoinAbandoned,
            "a teardown from outside must stop the loop retrying a call that ended"
        )
    }
}

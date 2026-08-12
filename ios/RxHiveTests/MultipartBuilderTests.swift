import XCTest

@testable import RxHive

/// The wire format of an upload body.
///
/// A filename reaches `MultipartBuilder` straight from the document picker
/// (`MessageComposer.stage`, `url.lastPathComponent`) and nothing on the way
/// rewrites it, so it can carry a quote or a newline. Interpolated raw those close
/// the quoted string early or start a header line of their own, and the body stops
/// being well-formed multipart — with no UI symptom until an upload fails. Hence
/// asserting the bytes directly rather than inferring them from a failed request.
///
/// The backend already strips the same three characters out of this value on the
/// way back out (`services/storage.py:414`); these tests hold the client to the
/// same line on the way in.
final class MultipartBuilderTests: XCTestCase {

    private func body(filename: String) -> Data {
        MultipartBuilder.body(
            boundary: "B",
            parts: [
                MultipartPart(
                    name: "file",
                    filename: filename,
                    mimeType: "application/pdf",
                    data: Data("x".utf8)
                )
            ],
            fields: [:]
        )
    }

    /// The header lines of the first part: everything before the blank line that
    /// ends the header block, minus the boundary itself.
    private func partHeaders(_ body: Data) -> [String] {
        let text = String(decoding: body, as: UTF8.self)
        guard let blankLine = text.range(of: "\r\n\r\n") else { return [] }
        return text[..<blankLine.lowerBound]
            .components(separatedBy: "\r\n")
            .filter { !$0.isEmpty && !$0.hasPrefix("--") }
    }

    func testQuotedFilenameCannotCloseTheQuotedString() {
        let text = String(decoding: body(filename: #"patient "smith" scan.pdf"#), as: UTF8.self)
        XCTAssertTrue(text.contains(#"filename="patient smith scan.pdf""#), text)
    }

    func testNewlineInFilenameCannotInjectAHeaderLine() {
        // Asserted on the NUMBER of header lines, not on the absence of the injected
        // text: once the CRLFs are stripped the characters are still there, they just
        // no longer form a line of their own. Two headers is the whole property —
        // Content-Disposition and Content-Type, never a third.
        let headers = partHeaders(body(filename: "a\r\nX-Injected: 1\r\nb.pdf"))
        XCTAssertEqual(headers.count, 2, "injected header line: \(headers)")
        XCTAssertTrue(headers[0].hasPrefix("Content-Disposition: form-data;"), headers[0])
        XCTAssertTrue(headers[1].hasPrefix("Content-Type:"), headers[1])
    }

    /// The extension has to survive: the server derives Content-Type from it and
    /// ignores what the client claims (`RxHiveAPI.upload`).
    func testOrdinaryFilenameIsUntouched() {
        let text = String(decoding: body(filename: "scan-2026.pdf"), as: UTF8.self)
        XCTAssertTrue(text.contains(#"filename="scan-2026.pdf""#), text)
    }
}

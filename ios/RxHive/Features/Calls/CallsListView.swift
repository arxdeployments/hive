import SwiftUI

/// The Calls tab: history, filtered, with tap-to-call-back.
///
/// The server does the per-requester work (`services/calls.py:serialize_call`
/// computes `direction` and `other_participant`), so a row renders without this
/// view knowing who the signed-in user is.
struct CallsListView: View {

    @EnvironmentObject private var calls: CallStore

    @State private var filter: Filter = .all
    @State private var entries: [CallHistoryEntry] = []
    @State private var isLoading = true
    @State private var isLoadingMore = false
    @State private var errorMessage: String?
    @State private var page = 1
    @State private var total = 0

    private let pageSize = 30

    /// The four buckets `api/calls.py:call_history` understands. The wire values are
    /// the raw strings, so the chip labels and the query stay in one place.
    enum Filter: String, CaseIterable, Identifiable {
        case all, missed, incoming, outgoing

        var id: String { rawValue }
        var title: String { rawValue.capitalized }
    }

    private var hasMore: Bool { entries.count < total }

    var body: some View {
        VStack(spacing: 0) {
            filterBar

            if isLoading {
                loadingList
            } else if let errorMessage {
                EmptyStateView(
                    systemImage: "exclamationmark.triangle",
                    title: "Couldn't load calls",
                    message: errorMessage,
                    actionTitle: "Try again"
                ) {
                    Task { await load(reset: true) }
                }
            } else if entries.isEmpty {
                EmptyStateView(
                    systemImage: "phone",
                    title: "No calls yet",
                    message: filter == .all
                        ? "Your call history will appear here."
                        : "No \(filter.rawValue) calls."
                )
            } else {
                historyList
            }
        }
        .background(Theme.Color.bg)
        .navigationTitle("Calls")
        .task {
            await load(reset: true)
            // Clears the missed-call badge. Opening the tab *is* seeing them, which
            // is exactly what `POST /api/calls/mark-seen` records.
            await calls.markCallsSeen()
        }
    }

    // MARK: - Filters

    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Layout.spacing2) {
                ForEach(Filter.allCases) { option in
                    FilterChip(title: option.title, isSelected: filter == option) {
                        guard filter != option else { return }
                        filter = option
                        Task { await load(reset: true) }
                    }
                }
            }
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.vertical, Theme.Layout.spacing2)
        }
        .background(Theme.Color.bg)
    }

    // MARK: - Lists

    private var loadingList: some View {
        VStack(spacing: Theme.Layout.spacing4) {
            ForEach(0..<6, id: \.self) { _ in
                HStack(spacing: Theme.Layout.spacing3) {
                    Circle()
                        .fill(Theme.Color.surface2)
                        .frame(width: Theme.Layout.avatarMedium, height: Theme.Layout.avatarMedium)
                    VStack(alignment: .leading, spacing: 6) {
                        SkeletonRow(height: 15, widthFraction: 0.45)
                        SkeletonRow(height: 11, widthFraction: 0.28)
                    }
                }
            }
            Spacer()
        }
        .padding(Theme.Layout.gutter)
    }

    private var historyList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(groups) { group in
                    SectionHeader(title: group.id)
                        .padding(.horizontal, Theme.Layout.gutter)
                        .padding(.top, Theme.Layout.spacing4)
                        .padding(.bottom, Theme.Layout.spacing2)

                    ForEach(group.entries) { entry in
                        CallHistoryRow(entry: entry) { calls.callBack(entry) }
                        Hairline().padding(.leading, 72)
                    }
                }

                if hasMore {
                    ProgressView()
                        .tint(Theme.Color.textMuted)
                        .frame(maxWidth: .infinity)
                        .padding(Theme.Layout.spacing5)
                        .task { await loadMore() }
                }
            }
            .padding(.bottom, Theme.Layout.spacing6)
        }
        .refreshable { await load(reset: true) }
    }

    /// One day's rows. The label is the identity: the server returns newest-first, so
    /// a day appears exactly once and cannot collide.
    private struct DaySection: Identifiable {
        let id: String
        var entries: [CallHistoryEntry]
    }

    /// Rows bucketed by day, in the order the server returned them, reusing the
    /// message list's date wording so the whole app says "Today" the same way.
    private var groups: [DaySection] {
        var result: [DaySection] = []
        for entry in entries {
            let label = entry.startedAt?.dateSeparatorLabel ?? "Earlier"
            if result.last?.id == label {
                result[result.count - 1].entries.append(entry)
            } else {
                result.append(DaySection(id: label, entries: [entry]))
            }
        }
        return result
    }

    // MARK: - Loading

    private func load(reset: Bool) async {
        if reset {
            isLoading = entries.isEmpty
            page = 1
        }
        errorMessage = nil
        do {
            let response = try await RxHiveAPI.callHistory(page: 1, limit: pageSize, filter: filter.rawValue)
            entries = response.data
            total = response.total
            page = 1
        } catch {
            errorMessage = (error as? APIError)?.userMessage ?? "Couldn't load calls"
        }
        isLoading = false
    }

    private func loadMore() async {
        guard !isLoadingMore, hasMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let next = page + 1
            let response = try await RxHiveAPI.callHistory(page: next, limit: pageSize, filter: filter.rawValue)
            // De-dupe on id: a call that ended between pages shifts the offset
            // window, and the same row can arrive twice.
            let known = Set(entries.map(\.id))
            entries.append(contentsOf: response.data.filter { !known.contains($0.id) })
            total = response.total
            page = next
        } catch {
            // Silent: the first page is on screen and a failed page-two is not worth
            // replacing it with an error state.
            total = entries.count
        }
    }
}

// MARK: - Row

private struct CallHistoryRow: View {
    let entry: CallHistoryEntry
    let action: () -> Void

    /// Red only for a call that came in and was never answered. An outgoing call to
    /// someone who did not pick up is not the user's missed call.
    private var isMissed: Bool {
        entry.status == .missed && !entry.isOutgoing
    }

    private var name: String {
        entry.otherParticipant?.displayName ?? (entry.isGroup ? "Group call" : "Unknown")
    }

    private var directionIcon: String {
        entry.isOutgoing ? "phone.arrow.up.right" : "phone.arrow.down.left"
    }

    private var directionTint: Color {
        if isMissed { return Theme.Color.danger }
        return entry.status.isMissedOrRejected ? Theme.Color.warning : Theme.Color.primary
    }

    private var directionLabel: String {
        if isMissed { return "Missed" }
        switch entry.status {
        case .declined: return "Declined"
        case .cancelled: return "Cancelled"
        case .busy: return "Busy"
        case .noAnswer: return "No answer"
        default: return entry.isOutgoing ? "Outgoing" : "Incoming"
        }
    }

    private var durationLabel: String? {
        guard let duration = entry.duration, duration > 0 else { return nil }
        return CallStore.durationLabel(duration)
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.Layout.spacing3) {
                Avatar(
                    name: name,
                    urlPath: entry.otherParticipant?.avatarURL,
                    size: Theme.Layout.avatarMedium
                )

                VStack(alignment: .leading, spacing: 3) {
                    Text(name)
                        .font(Theme.Typography.font(size: 15, weight: .medium))
                        .foregroundStyle(isMissed ? Theme.Color.danger : Theme.Color.text)
                        .lineLimit(1)

                    HStack(spacing: 5) {
                        Image(systemName: directionIcon)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(directionTint)

                        Text(durationLabel.map { "\(directionLabel) · \($0)" } ?? directionLabel)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(isMissed ? Theme.Color.danger : Theme.Color.textMuted)
                            .lineLimit(1)

                        if entry.callType == .video {
                            Image(systemName: "video.fill")
                                .font(.system(size: 9))
                                .foregroundStyle(Theme.Color.textMuted)
                        }
                        if entry.isGroup {
                            Image(systemName: "person.2.fill")
                                .font(.system(size: 9))
                                .foregroundStyle(Theme.Color.textMuted)
                        }
                    }
                }

                Spacer(minLength: Theme.Layout.spacing2)

                Text(entry.startedAt?.conversationListLabel ?? "")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
            }
            .padding(.horizontal, Theme.Layout.gutter)
            .frame(minHeight: 64)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel("\(directionLabel) \(entry.callType == .video ? "video" : "voice") call with \(name). Tap to call back.")
    }
}

// `FilterChip` is shared — see `DesignSystem/Components.swift`. This file had its own
// private copy with a solid-emerald selected state, which meant the Chats and Calls
// tabs styled the same control differently.


export const TypingIndicator = ({ users }) => {
  if (!users || Object.keys(users).length === 0) return null;

  const names = Object.values(users);
  const text = names.length === 1
    ? `${names[0]} is typing`
    : `${names.join(', ')} are typing`;

  return (
    <div className="flex items-center gap-2 px-4 py-1">
      <div className="flex gap-1">
        <span className="w-1.5 h-1.5 bg-[#10B981] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1.5 h-1.5 bg-[#10B981] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1.5 h-1.5 bg-[#10B981] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
      <span className="text-xs text-[#10B981]">{text}</span>
    </div>
  );
};

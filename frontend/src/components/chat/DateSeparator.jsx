
export const DateSeparator = ({ date }) => {
  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());

    if (msgDate.getTime() === today.getTime()) return 'Today';
    if (msgDate.getTime() === yesterday.getTime()) return 'Yesterday';
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="flex items-center justify-center my-3">
      <span className="bg-[#1A1A1A] text-[#A3A3A3] text-xs px-3 py-1 rounded-[8px]">
        {formatDate(date)}
      </span>
    </div>
  );
};

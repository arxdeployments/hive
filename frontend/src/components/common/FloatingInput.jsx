import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export const FloatingInput = ({
  label,
  type = 'text',
  value,
  onChange,
  error,
  disabled,
  id: idProp,
  'data-testid': testId,
  ...props
}) => {
  // The label floats over the input and is pointer-events-none, so it was never
  // associated with it: no htmlFor, no id, no aria-label. Screen readers
  // therefore announced the login form as two unlabelled edit fields, with no
  // way to tell the email box from the password box. useId keeps the pairing
  // unique across the several FloatingInputs a page can render. A caller-supplied
  // id wins, but it has to flow through this one binding so the label follows it.
  const generatedId = useId();
  const inputId = idProp || generatedId;
  const [focused, setFocused] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const isActive = focused || (value && value.length > 0);
  const inputType = type === 'password' ? (showPassword ? 'text' : 'password') : type;

  return (
    <div className="relative w-full">
      <input
        type={inputType}
        value={value}
        onChange={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        data-testid={testId}
        className={`w-full h-[52px] px-4 pt-5 pb-1 text-sm bg-[#1A1A1A] border rounded-[6px] text-[#F5F5F5] outline-none transition-all duration-200 peer
          ${error ? 'border-[#EF4444]' : focused ? 'border-[#10B981] shadow-[0_0_0_3px_rgba(16,185,129,0.25)]' : 'border-[#2D2D2D]'}
          ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
          ${type === 'password' ? 'pr-12' : ''}
        `}
        placeholder=" "
        {...props}
        // After the spread: these two are the accessibility contract, not
        // defaults. An overridden id would leave the label pointing at nothing,
        // and an overridden aria-invalid would hide the error state — which is
        // otherwise border colour alone, invisible to a screen reader and to
        // anyone who cannot distinguish the two greens.
        id={inputId}
        aria-invalid={error ? true : undefined}
      />
      <label
        htmlFor={inputId}
        className={`absolute left-4 transition-all duration-200 pointer-events-none
          ${isActive
            ? 'top-2 text-xs ' + (error ? 'text-[#EF4444]' : 'text-[#10B981]')
            : 'top-1/2 -translate-y-1/2 text-sm text-[#A3A3A3]'
          }
        `}
      >
        {label}
      </label>
      {type === 'password' && (
        <button
          type="button"
          onClick={() => setShowPassword(!showPassword)}
          className="absolute right-4 top-1/2 -translate-y-1/2 text-[#A3A3A3] hover:text-[#F5F5F5] transition-colors"
          tabIndex={-1}
          data-testid={testId ? `${testId}-toggle` : undefined}
        >
          {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      )}
    </div>
  );
};

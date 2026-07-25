/**
 * Two-column info drawer: a left navigation rail that swaps the right pane.
 *
 * Shared by GroupInfoPanel and ContactInfoPanel so both stay pixel-identical.
 * The drawer motion (slide in from the right, 0.3s, [0.2, 0.8, 0.2, 1]) is the
 * same curve the rest of the app's drawers use.
 *
 * On <md the two columns stack: the rail becomes a horizontally scrolling tab
 * strip above the content, so nothing needs a second "back" navigation state.
 */

import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

export const InfoPanelShell = ({
  isOpen,
  onClose,
  title,
  sections,
  activeSection,
  onSectionChange,
  navTestIdPrefix,
  panelTestId,
  children,
}) => {
  const panelRef = useRef(null);

  // Escape closes the drawer. Bound on the document so it works no matter where
  // focus currently sits inside the panel.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  // Each section change scrolls the content pane back to the top — otherwise a
  // deep scroll in Media carries over into a two-line Encryption blurb.
  useEffect(() => {
    panelRef.current?.scrollTo?.({ top: 0 });
  }, [activeSection]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50"
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            data-testid={panelTestId}
            className="absolute right-0 top-0 h-full w-full md:w-[720px] lg:w-[840px] bg-[#0A0A0A] border-l border-[#1F1F1F] shadow-[0_0_80px_rgba(0,0,0,0.6)] flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#1F1F1F] shrink-0">
              <h3 className="text-base font-semibold text-[#F5F5F5]">{title}</h3>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                data-testid={`${navTestIdPrefix}close`}
                className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 min-h-0 flex flex-col md:flex-row">
              {/* Left rail */}
              <nav
                aria-label={`${title} sections`}
                className="shrink-0 md:w-[240px] bg-[#141414] border-b md:border-b-0 md:border-r border-[#1F1F1F] p-2 flex md:flex-col gap-1 overflow-x-auto md:overflow-y-auto scrollable-area"
              >
                {sections.map((section) => {
                  const Icon = section.icon;
                  const active = section.id === activeSection;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => onSectionChange(section.id)}
                      aria-current={active ? 'page' : undefined}
                      data-testid={`${navTestIdPrefix}${section.id}`}
                      className={`shrink-0 md:w-full flex items-center gap-2.5 px-3 py-2.5 rounded-[8px] text-left transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-[#10B981]/10 text-[#10B981]'
                          : 'text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A]'
                      }`}
                    >
                      {Icon && <Icon size={16} className="shrink-0" />}
                      <span className="text-sm md:truncate">{section.label}</span>
                      {section.badge != null && (
                        <span
                          className={`ml-auto text-[11px] px-1.5 py-0.5 rounded-full ${
                            active ? 'bg-[#10B981]/20 text-[#10B981]' : 'bg-[#1F1F1F] text-[#A3A3A3]'
                          }`}
                        >
                          {section.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>

              {/* Right content */}
              <div
                ref={panelRef}
                className="flex-1 min-w-0 overflow-y-auto scrollable-area"
                data-testid={`${navTestIdPrefix}content`}
              >
                {children}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

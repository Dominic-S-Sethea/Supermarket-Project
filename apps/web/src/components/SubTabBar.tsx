import { type KeyboardEvent, type ReactNode, useRef } from "react";

export interface SubTabItem<T extends string> {
  id: T;
  elementId: string;
  label: ReactNode;
  panelId: string;
}

/**
 * WAI-ARIA APG compliant TabList bar supporting roving tabIndex,
 * ArrowLeft / ArrowRight / Home / End keyboard navigation, and linked tabpanels.
 */
export function SubTabBar<T extends string>({
  ariaLabel,
  tabs,
  activeId,
  onSelect,
}: {
  ariaLabel: string;
  tabs: readonly SubTabItem<T>[];
  activeId: T;
  onSelect: (id: T) => void;
}) {
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const focusAndSelect = (index: number) => {
    const target = tabs[index];
    if (!target) return;
    onSelect(target.id);
    buttonRefs.current[target.id]?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    if (tabs.length <= 1) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusAndSelect((currentIndex + 1) % tabs.length);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusAndSelect((currentIndex - 1 + tabs.length) % tabs.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAndSelect(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAndSelect(tabs.length - 1);
    }
  };

  return (
    <div className="subtab-bar" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab, idx) => {
        const isSelected = tab.id === activeId;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              buttonRefs.current[tab.id] = el;
            }}
            id={tab.elementId}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-controls={tab.panelId}
            tabIndex={isSelected ? 0 : -1}
            className={`subtab-btn ${isSelected ? "active" : ""}`}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

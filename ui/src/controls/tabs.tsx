import { useState, useRef, type KeyboardEvent, type ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import {
  getAccessibleName,
  type ControlEventHandlers,
  type ProjectedControlData,
} from "./projected-data";

export type TabsProps = PlatformBlockRenderProps & {
  controlData?: ProjectedControlData;
  controlEvents?: ControlEventHandlers;
};

type TabDescriptor = {
  key: string;
  slotKey: string;
  label: string;
};

/**
 * Accessible tabs component following the WAI-ARIA tabs pattern:
 * - role="tablist" with aria-label
 * - role="tab" with aria-selected, aria-controls, and roving tabIndex (0 on active, -1 on inactive)
 * - role="tabpanel" with aria-labelledby
 * - Arrow navigation (Left/Right), Home/End, Enter/Space activation
 * - Emits declared tab_changed semantic event
 */
export function Tabs({
  placementId,
  settings,
  metadata,
  slots,
  availability,
  controlData,
  controlEvents,
}: TabsProps): ReactElement {
  const title = getAccessibleName(settings, metadata) ?? "Tabs";
  const defaultTab = settings.default_tab?.kind === "text" ? settings.default_tab.value : undefined;

  // Determine available tabs based on slots and label settings
  const declaredTabs: TabDescriptor[] = [
    {
      key: "tab_one",
      slotKey: "tab_one",
      label:
        settings.tab_one_label?.kind === "text" && settings.tab_one_label.value.trim().length > 0
          ? settings.tab_one_label.value.trim()
          : "Tab 1",
    },
    {
      key: "tab_two",
      slotKey: "tab_two",
      label:
        settings.tab_two_label?.kind === "text" && settings.tab_two_label.value.trim().length > 0
          ? settings.tab_two_label.value.trim()
          : "Tab 2",
    },
    {
      key: "tab_three",
      slotKey: "tab_three",
      label:
        settings.tab_three_label?.kind === "text" && settings.tab_three_label.value.trim().length > 0
          ? settings.tab_three_label.value.trim()
          : "Tab 3",
    },
    {
      key: "tab_four",
      slotKey: "tab_four",
      label:
        settings.tab_four_label?.kind === "text" && settings.tab_four_label.value.trim().length > 0
          ? settings.tab_four_label.value.trim()
          : "Tab 4",
    },
  ].filter((t) => slots[t.slotKey] !== undefined && slots[t.slotKey] !== null);

  // Fallback if no child slots supplied yet
  const effectiveTabs: TabDescriptor[] =
    declaredTabs.length > 0
      ? declaredTabs
      : [
          {
            key: "tab_one",
            slotKey: "tab_one",
            label:
              settings.tab_one_label?.kind === "text" && settings.tab_one_label.value.trim().length > 0
                ? settings.tab_one_label.value.trim()
                : "Tab 1",
          },
        ];

  const initialTabKey =
    defaultTab && effectiveTabs.some((t) => t.key === defaultTab)
      ? defaultTab
      : effectiveTabs[0]?.key ?? "tab_one";

  const projectedTab =
    controlData?.status === "ready" && controlData.values.kind === "tabs"
      ? controlData.values.activeTab
      : undefined;

  const [internalActiveTab, setInternalActiveTab] = useState<string>(initialTabKey);
  const activeTabKey =
    projectedTab && effectiveTabs.some((t) => t.key === projectedTab)
      ? projectedTab
      : internalActiveTab;

  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const selectTab = (tabKey: string): void => {
    setInternalActiveTab(tabKey);
    tabButtonRefs.current[tabKey]?.focus();
    if (availability === "available" && controlEvents?.tab_changed) {
      controlEvents.tab_changed({
        event: "tab_changed",
        tabKey,
      });
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, currentIndex: number): void => {
    let nextIndex = -1;
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        nextIndex = (currentIndex + 1) % effectiveTabs.length;
        break;
      case "ArrowLeft":
        e.preventDefault();
        nextIndex = (currentIndex - 1 + effectiveTabs.length) % effectiveTabs.length;
        break;
      case "Home":
        e.preventDefault();
        nextIndex = 0;
        break;
      case "End":
        e.preventDefault();
        nextIndex = effectiveTabs.length - 1;
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        selectTab(effectiveTabs[currentIndex]!.key);
        return;
      default:
        return;
    }

    if (nextIndex >= 0 && nextIndex < effectiveTabs.length) {
      selectTab(effectiveTabs[nextIndex]!.key);
    }
  };

  const activeTabDescriptor = effectiveTabs.find((t) => t.key === activeTabKey) ?? effectiveTabs[0]!;
  const activePanelContent = slots[activeTabDescriptor.slotKey] ?? null;

  return (
    <div
      data-vortex-control="tabs"
      data-vortex-active-tab={activeTabKey}
      data-vortex-availability={availability}
      className="vortex-tabs-container"
      style={{ display: "flex", flexDirection: "column", width: "100%" }}
    >
      <div
        role="tablist"
        aria-label={title}
        className="vortex-tablist"
        style={{
          display: "flex",
          gap: "0.25rem",
          borderBottom: "1px solid #e5e7eb",
          marginBottom: "1rem",
        }}
      >
        {effectiveTabs.map((tab, idx) => {
          const isActive = tab.key === activeTabKey;
          const tabId = `vortex-tab-${placementId}-${tab.key}`;
          const panelId = `vortex-tabpanel-${placementId}-${tab.key}`;
          return (
            <button
              key={tab.key}
              id={tabId}
              ref={(el) => {
                tabButtonRefs.current[tab.key] = el;
              }}
              type="button"
              role="tab"
              aria-selected={isActive ? "true" : "false"}
              aria-controls={panelId}
              tabIndex={isActive ? 0 : -1}
              onClick={() => selectTab(tab.key)}
              onKeyDown={(e) => handleKeyDown(e, idx)}
              className={`vortex-tab-button ${isActive ? "active" : ""}`}
              style={{
                padding: "0.5rem 1rem",
                fontWeight: isActive ? 600 : 400,
                color: isActive ? "#2563eb" : "#4b5563",
                borderBottom: isActive ? "2px solid #2563eb" : "2px solid transparent",
                background: "transparent",
                borderTop: "none",
                borderLeft: "none",
                borderRight: "none",
                cursor: "pointer",
                outline: "none",
                marginBottom: "-1px",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        key={activeTabDescriptor.key}
        id={`vortex-tabpanel-${placementId}-${activeTabDescriptor.key}`}
        role="tabpanel"
        aria-labelledby={`vortex-tab-${placementId}-${activeTabDescriptor.key}`}
        tabIndex={0}
        className="vortex-tabpanel"
        style={{ width: "100%", outline: "none" }}
      >
        {activePanelContent}
      </div>
    </div>
  );
}

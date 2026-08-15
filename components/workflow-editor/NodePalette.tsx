'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NodeTypeIcon } from '@/components/execution/NodeTypeIcon';
import { getAllNodeDefs, getCategories, CATEGORY_META } from '@/lib/node-registry';

// ─── Props ────────────────────────────────────────────────────────────────────

interface NodePaletteProps {
  onAddNode: (type: string, label: string) => void;
  disabled?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function NodePalette({ onAddNode, disabled }: NodePaletteProps) {
  const [collapsed, setCollapsed] = useState(false);
  const categories = getCategories();
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(categories),
  );

  function toggleCategory(cat: string) {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  }

  if (collapsed) {
    return (
      <div className="flex flex-col bg-card border border-border rounded-lg shadow-sm overflow-hidden">
        <button
          onClick={() => setCollapsed(false)}
          className="p-2 hover:bg-muted/40 text-muted-foreground hover:text-foreground transition-colors"
          title="Show node palette"
          aria-label="Expand node palette"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      </div>
    );
  }

  const allDefs = getAllNodeDefs();

  return (
    <div className="flex flex-col w-48 max-h-[calc(100vh-12rem)] bg-card border border-border rounded-lg shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20 flex-shrink-0">
        <span className="text-xs font-semibold text-foreground">Nodes</span>
        <button
          onClick={() => setCollapsed(true)}
          className="p-0.5 hover:bg-muted/60 rounded text-muted-foreground hover:text-foreground transition-colors"
          title="Collapse palette"
          aria-label="Collapse node palette"
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Categories */}
      <div className="overflow-y-auto flex-1 py-1">
        {categories.map((cat) => {
          const nodes = allDefs.filter((d) => d.category === cat);
          const isOpen = expandedCategories.has(cat);
          const catLabel = CATEGORY_META[cat].label;

          return (
            <div key={cat}>
              {/* Category header */}
              <button
                onClick={() => toggleCategory(cat)}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-muted/30 transition-colors"
              >
                {isOpen
                  ? <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                  : <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                }
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  {catLabel}
                </span>
              </button>

              {/* Node items */}
              {isOpen && (
                <div className="pb-1">
                  {nodes.map((def) => (
                    <button
                      key={def.type}
                      onClick={() => !disabled && onAddNode(def.type, def.label)}
                      disabled={disabled}
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs',
                        'hover:bg-muted/40 transition-colors',
                        'disabled:opacity-40 disabled:cursor-not-allowed',
                      )}
                      title={`Add ${def.label} node — ${def.description}`}
                    >
                      <NodeTypeIcon nodeType={def.type} size="sm" className="flex-shrink-0 h-5 w-5" />
                      <span className="text-foreground truncate">{def.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="px-3 py-2 border-t border-border bg-muted/10 flex-shrink-0">
        <p className="text-[10px] text-muted-foreground">Click to add · Drag to move</p>
      </div>
    </div>
  );
}

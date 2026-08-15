import {
  Zap,
  Webhook,
  ShoppingBag,
  MessageSquare,
  Table2,
  Mail,
  HardDrive,
  Code2,
  Clock,
  GitBranch,
  Globe,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getNodeDef } from '@/lib/node-registry';

// ─── Fallback resolution (for unregistered / legacy node types) ───────────────

const FALLBACK_ICONS: Array<[string, LucideIcon]> = [
  ['webhook',     Webhook],
  ['shopify',     ShoppingBag],
  ['slack',       MessageSquare],
  ['airtable',    Table2],
  ['email',       Mail],
  ['gmail',       Mail],
  ['googledrive', HardDrive],
  ['code',        Code2],
  ['wait',        Clock],
  ['if',          GitBranch],
  ['condition',   GitBranch],
  ['httprequest', Globe],
  ['openai',      Sparkles],
  ['trigger',     Zap],
];

const FALLBACK_COLORS: Array<[string, string]> = [
  ['shopify',     'bg-green-100 text-green-700'],
  ['slack',       'bg-purple-100 text-purple-700'],
  ['airtable',    'bg-yellow-100 text-yellow-700'],
  ['email',       'bg-blue-100 text-blue-700'],
  ['gmail',       'bg-blue-100 text-blue-700'],
  ['googledrive', 'bg-sky-100 text-sky-700'],
  ['webhook',     'bg-orange-100 text-orange-700'],
  ['trigger',     'bg-orange-100 text-orange-700'],
  ['code',        'bg-gray-100 text-gray-700'],
  ['wait',        'bg-gray-100 text-gray-700'],
  ['if',          'bg-violet-100 text-violet-700'],
  ['condition',   'bg-violet-100 text-violet-700'],
  ['httprequest', 'bg-cyan-100 text-cyan-700'],
  ['openai',      'bg-emerald-100 text-emerald-700'],
];

function fallbackIcon(nodeType: string): LucideIcon {
  const lc = nodeType.toLowerCase();
  for (const [key, Icon] of FALLBACK_ICONS) {
    if (lc.includes(key)) return Icon;
  }
  return Zap;
}

function fallbackColor(nodeType: string): string {
  const lc = nodeType.toLowerCase();
  for (const [key, cls] of FALLBACK_COLORS) {
    if (lc.includes(key)) return cls;
  }
  return 'bg-gray-100 text-gray-600';
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  nodeType: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_CLS = {
  sm:  { wrap: 'h-7 w-7 rounded',      icon: 'h-3.5 w-3.5' },
  md:  { wrap: 'h-9 w-9 rounded-lg',   icon: 'h-4 w-4'     },
  lg:  { wrap: 'h-11 w-11 rounded-xl', icon: 'h-5 w-5'     },
};

export function NodeTypeIcon({ nodeType, size = 'md', className }: Props) {
  const def   = getNodeDef(nodeType);
  const Icon  = def?.icon      ?? fallbackIcon(nodeType);
  const color = def?.iconColor ?? fallbackColor(nodeType);
  const sz    = SIZE_CLS[size];

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center flex-shrink-0',
        sz.wrap, color, className,
      )}
    >
      <Icon className={sz.icon} />
    </span>
  );
}

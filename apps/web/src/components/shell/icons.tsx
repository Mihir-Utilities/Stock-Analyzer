import {
  Bell,
  BookOpen,
  Briefcase,
  CircleHelp,
  Download,
  Ellipsis,
  GitCompare,
  House,
  LineChart,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Sun,
  type LucideIcon,
} from "lucide-react";
import type { NavItem } from "./nav";

// lucide-react only, 20 px, stroke 1.75 (docs/06a section 8).
const map: Record<NavItem["icon"], LucideIcon> = {
  home: House,
  stocks: LineChart,
  funds: BookOpen,
  portfolio: Briefcase,
  compare: GitCompare,
  screener: SlidersHorizontal,
  alerts: Bell,
  watchlist: Star,
  imports: Download,
  settings: Settings,
  admin: ShieldCheck,
};

export function NavIcon({ name }: { name: NavItem["icon"] }) {
  const Icon = map[name] ?? CircleHelp;
  return <Icon size={20} strokeWidth={1.75} aria-hidden="true" />;
}

export const icons = { Moon, Sun, Ellipsis, PanelLeftClose, PanelLeftOpen };

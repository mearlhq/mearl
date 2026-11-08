import {
  AppWindow,
  Blocks,
  ChartNoAxesCombined,
  FolderGit2,
  GitBranch,
  Layers,
  Languages,
  NotebookPen,
  Package,
  Smartphone,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ComponentType } from 'react';
import { parseToolboxIcon } from '@mearl/browser-core';

const PLUGIN_ICONS: Record<string, LucideIcon> = {
  'app-window': AppWindow,
  blocks: Blocks,
  chart: ChartNoAxesCombined,
  'folder-git': FolderGit2,
  'git-branch': GitBranch,
  layers: Layers,
  languages: Languages,
  'notebook-pen': NotebookPen,
  package: Package,
  smartphone: Smartphone,
  terminal: Terminal,
  wrench: Wrench,
};

export function toolboxIcon(name?: string): LucideIcon {
  return (name && PLUGIN_ICONS[name]) || Blocks;
}

export type ToolboxIconSource = string | ComponentType<{ className?: string }>;

interface ToolboxIconProps {
  icon?: ToolboxIconSource;
  className?: string;
}

export function ToolboxIcon({ icon, className }: ToolboxIconProps) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (icon && typeof icon !== 'string') {
    const Icon = icon;
    return <Icon className={className} aria-hidden="true" />;
  }
  const parsed = parseToolboxIcon(icon);
  if (parsed?.kind === 'image' && failedSource !== parsed.src) {
    if (parsed.monochrome) {
      return (
        <span
          aria-hidden="true"
          className={`${className ?? 'h-4 w-4'} inline-block shrink-0 bg-current`}
          style={{
            maskImage: `url("${parsed.src}")`,
            maskPosition: 'center',
            maskSize: 'contain',
            maskRepeat: 'no-repeat',
          }}
        >
          <img
            src={parsed.src}
            alt=""
            className="hidden"
            onError={() => setFailedSource(parsed.src)}
          />
        </span>
      );
    }
    return (
      <img
        src={parsed.src}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        className={`${className ?? 'h-4 w-4'} object-contain`}
        onError={() => setFailedSource(parsed.src)}
      />
    );
  }
  const Icon = toolboxIcon(parsed?.kind === 'name' ? parsed.name : undefined);
  return <Icon className={className} aria-hidden="true" />;
}

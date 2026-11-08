import { existsSync, lstatSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DISABLED_SKILL_MANIFEST = 'SKILL.md.mearl-disabled';

/** Read the identity fields used by the runtime, including disabled Skills. */
export function readInstalledSkillMetadata(directory: string): { name?: string; version?: string } | undefined {
  if (existsSync(join(directory, 'SKILL.md')) && existsSync(join(directory, DISABLED_SKILL_MANIFEST))) throw new Error('Conflicting installed Skill manifests');
  const file = skillManifestPath(directory);
  if (!file) return undefined;
  const info = statSync(file);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid installed Skill manifest');
  const frontmatter = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!frontmatter) return {};
  const scalar = (key: string) => {
    const lines = frontmatter.split(/\r?\n/).filter(line => line.startsWith(key + ':'));
    if (lines.length !== 1) return undefined;
    return lines[0].match(/^[\w-]+:\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#"']+))\s*(?:#.*)?$/)?.slice(1).find(value => value !== undefined);
  };
  return { name: scalar('name'), version: scalar('version') };
}

/** 保留的清单供工具运行时读取，但不参与 Agent 的 SKILL.md 发现。 */
export function skillManifestPath(directory: string): string | undefined {
  for (const name of ['SKILL.md', DISABLED_SKILL_MANIFEST]) {
    const file = join(directory, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

export function getSkillEnabled(directory: string): boolean | undefined {
  const manifest = skillManifestPath(directory);
  return manifest ? manifest === join(directory, 'SKILL.md') : undefined;
}

export function setSkillEnabled(directory: string, enabled: boolean): void {
  const active = join(directory, 'SKILL.md');
  const disabled = join(directory, DISABLED_SKILL_MANIFEST);
  const source = enabled ? disabled : active;
  const destination = enabled ? active : disabled;
  const sourceStatus = lstatSync(source, { throwIfNoEntry: false });
  const destinationStatus = lstatSync(destination, { throwIfNoEntry: false });
  if (sourceStatus && destinationStatus) {
    throw new Error('Skill 清单存在冲突，请检查 SKILL.md 和 SKILL.md.mearl-disabled');
  }
  if (!sourceStatus) {
    if (destinationStatus?.isFile()) return;
    throw new Error('找不到 Skill 清单');
  }
  if (!sourceStatus.isFile()) throw new Error('Skill 清单必须是普通文件');
  renameSync(source, destination);
}

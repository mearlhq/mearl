import AdmZip from 'adm-zip';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 读取版本号
const packageJsonPath = resolve(__dirname, '../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const version = packageJson.version;

const distDir = resolve(__dirname, '../dist_chrome');
const buildDir = resolve(__dirname, '../build');
const zipFileName = `mearl-chrome-v${version}.zip`;
const zipFile = resolve(buildDir, zipFileName);
const distZipFile = resolve(distDir, zipFileName);

// 确保 build 目录存在
if (!existsSync(buildDir)) {
  mkdirSync(buildDir, { recursive: true });
}

// 创建 zip 文件
console.log('📦 Packaging Chrome extension...');
const zip = new AdmZip();

const addDistFilesToZip = (currentDir, zipDir = '') => {
  const entries = readdirSync(currentDir, { withFileTypes: true });

  entries.forEach((entry) => {
    const fullPath = resolve(currentDir, entry.name);
    const zipPath = zipDir ? `${zipDir}/${entry.name}` : entry.name;

    if (zipPath === 'skills' || zipPath.startsWith('skills/')) return;
    if (zipPath === '.vite' || zipPath.startsWith('.vite/')) return;
    if (entry.name === '.DS_Store') return;
    if (zipPath.endsWith('.zip')) return;

    if (entry.isDirectory()) {
      addDistFilesToZip(fullPath, zipPath);
      return;
    }

    zip.addFile(zipPath, readFileSync(fullPath));
  });
};

addDistFilesToZip(distDir);

// build/ 目录的 zip 保持原始域名白名单
zip.writeZip(zipFile);

// dist_chrome/ 目录的离线 zip：将 host_permissions、content_scripts.matches、web_accessible_resources.matches 改为 <all_urls>
const manifestPath = resolve(distDir, 'manifest.json');
const manifestJson = JSON.parse(readFileSync(manifestPath, 'utf-8'));

manifestJson.host_permissions = ['<all_urls>'];
delete manifestJson.optional_host_permissions;
if (Array.isArray(manifestJson.content_scripts)) {
  manifestJson.content_scripts = manifestJson.content_scripts.map((script) => ({
    ...script,
    matches: ['<all_urls>'],
  }));
}
if (Array.isArray(manifestJson.web_accessible_resources)) {
  manifestJson.web_accessible_resources = manifestJson.web_accessible_resources.map((resource) => ({
    ...resource,
    matches: ['<all_urls>'],
  }));
}

zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifestJson, null, 2), 'utf-8'));
const offlineArchive = zip.toBuffer();
writeFileSync(distZipFile, offlineArchive);

console.log('✅ Package created:', zipFile);
console.log('✅ Offline package created:', distZipFile);

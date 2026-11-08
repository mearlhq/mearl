import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = resolve(__dirname, '..');
const srcDir = resolve(rootDir, 'src');
const localesDir = resolve(rootDir, 'src/locales');

// 读取所有 messages.json 文件
function readMessagesFiles() {
  const locales = {};
  const localesDirs = readdirSync(localesDir);

  for (const locale of localesDirs) {
    const messagesPath = join(localesDir, locale, 'messages.json');
    try {
      const content = JSON.parse(readFileSync(messagesPath, 'utf-8'));
      locales[locale] = {
        path: messagesPath,
        keys: Object.keys(content),
        content: content,
      };
    } catch (error) {
      console.warn(`⚠️  Cannot read ${messagesPath}:`, error.message);
    }
  }

  return locales;
}

// 递归扫描目录下的所有 .ts, .tsx 文件
function scanFiles(dir, fileList = []) {
  const files = readdirSync(dir);

  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);

    if (stat.isDirectory()) {
      // 跳过 node_modules, dist 等目录
      if (!['node_modules', 'dist', 'dist_chrome', 'build', '.git'].includes(file)) {
        scanFiles(filePath, fileList);
      }
    } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      fileList.push(filePath);
    }
  }

  return fileList;
}

function calledFunctionName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

export function extractI18nKeysFromSource(content, fileName = 'source.ts') {
  const usedKeys = new Set();
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const functionName = calledFunctionName(node.expression);
      const firstArgument = node.arguments[0];
      if (
        (functionName === 't' || functionName === 'getMessage' || functionName === 'i18nMessage') &&
        firstArgument &&
        (ts.isStringLiteral(firstArgument) || ts.isNoSubstitutionTemplateLiteral(firstArgument))
      ) {
        usedKeys.add(firstArgument.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return usedKeys;
}

// 从代码中提取所有使用的 i18n key
export function extractUsedKeys(files) {
  const usedKeys = new Set();

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      const fileKeys = extractI18nKeysFromSource(content, file);
      for (const key of fileKeys) {
        usedKeys.add(key);
      }
    } catch (error) {
      console.warn(`⚠️  Cannot read ${file}:`, error.message);
    }
  }

  return usedKeys;
}

// 检查在 manifest 或配置文件中使用的 keys
function extractManifestKeys() {
  const manifestKeys = new Set();
  const configFiles = [
    resolve(rootDir, 'manifest.ts'),
    resolve(rootDir, 'vite.config.base.ts'),
    resolve(rootDir, 'vite.config.chrome.ts'),
  ];

  for (const file of configFiles) {
    try {
      if (!existsSync(file)) continue;
      const content = readFileSync(file, 'utf-8');
      // 匹配 __MSG_xxx__ 格式
      const matches = content.matchAll(/__MSG_([^_]+)__/g);
      for (const match of matches) {
        manifestKeys.add(match[1]);
      }
    } catch (error) {
      console.warn(`⚠️  Cannot read ${file}:`, error.message);
    }
  }

  return manifestKeys;
}

// 主函数
function main() {
  console.log('🔍 Scanning for unused i18n keys...\n');

  // 1. 读取所有 messages.json
  const locales = readMessagesFiles();
  console.log(
    `📖 Found ${Object.keys(locales).length} locale(s): ${Object.keys(locales).join(', ')}`,
  );

  // 2. 扫描所有源代码文件
  const files = scanFiles(srcDir);
  console.log(`📄 Scanned ${files.length} source files`);

  // 3. 提取使用的 keys
  const usedKeys = extractUsedKeys(files);
  const manifestKeys = extractManifestKeys();

  // 合并所有使用的 keys
  const allUsedKeys = new Set([...usedKeys, ...manifestKeys]);

  console.log(`✓ Found ${usedKeys.size} used keys in source code`);
  console.log(`✓ Found ${manifestKeys.size} used keys in manifest/config`);
  console.log(`✓ Total used keys: ${allUsedKeys.size}\n`);

  // 4. 找出未使用的 keys
  const results = {};
  let totalUnused = 0;

  for (const [locale, data] of Object.entries(locales)) {
    const unusedKeys = data.keys.filter(key => !allUsedKeys.has(key));
    results[locale] = unusedKeys;
    totalUnused += unusedKeys.length;

    if (unusedKeys.length > 0) {
      console.log(`\n📝 ${locale}:`);
      console.log(`   Total keys: ${data.keys.length}`);
      console.log(`   Used keys: ${data.keys.length - unusedKeys.length}`);
      console.log(`   Unused keys: ${unusedKeys.length}`);
      console.log(`   Unused keys list:`);
      unusedKeys.forEach(key => {
        console.log(`     - ${key}`);
      });
    }
  }

  // 5. 询问是否删除
  if (totalUnused === 0) {
    console.log('\n✅ No unused keys found! All keys are being used.');
    return;
  }

  console.log(
    `\n📊 Summary: Found ${totalUnused} unused key(s) across ${Object.keys(results).length} locale(s)`,
  );
  console.log('\n💡 To remove unused keys, run: node scripts/clean-i18n.js --remove');

  // 如果有 --remove 参数，则删除未使用的 keys
  if (process.argv.includes('--remove')) {
    console.log('\n🗑️  Removing unused keys...');

    for (const [locale, unusedKeys] of Object.entries(results)) {
      if (unusedKeys.length === 0) continue;

      const localeData = locales[locale];
      const newContent = {};

      // 只保留使用的 keys
      for (const key of localeData.keys) {
        if (!unusedKeys.includes(key)) {
          newContent[key] = localeData.content[key];
        }
      }

      // 写回文件
      writeFileSync(localeData.path, JSON.stringify(newContent, null, 2) + '\n', 'utf-8');

      console.log(`   ✓ Cleaned ${locale}: removed ${unusedKeys.length} key(s)`);
    }

    console.log('\n✅ Done! All unused keys have been removed.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}

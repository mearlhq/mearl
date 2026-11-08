/** 统一扩展内容页在浏览器标签中的标题格式。 */
export function setExtensionPageTitle(label: string): void {
  document.title = label ? `${label} - Mearl` : 'Mearl';
}

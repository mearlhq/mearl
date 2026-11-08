/** 在当前浏览器窗口的新标签页中打开扩展内容页。 */
export async function openExtensionTab(url: string): Promise<void> {
  await chrome.tabs.create({ url, active: true });
}

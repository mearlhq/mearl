function wrapPosix(script, id, token) {
  const escaped = script.replaceAll('\\', '\\\\').replaceAll('\n', '\\0012').replaceAll('\t', '\\0011');
  const quoted = "'" + escaped.replaceAll("'", "'\\''") + "'";
  const body = "; if sh -c \"$(printf '%b' " + quoted + ")\" </dev/null; then rc=0; else rc=$?; fi";
  return {
    buffer: "(printf '\\033]6973;%s;start\\007' " + id + body
      + "; printf '\\033]6973;%s;%s\\007' " + id + ' "$rc")\r',
    screen: "(printf '\\n[+%s]\\n' " + token + body
      + "; printf '\\n[-%s:%s]\\n' " + token + ' "$rc")\r',
  };
}

function wrapPowerShell(script, id, token) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const body = "; $ErrorActionPreference='Stop'; $PSNativeCommandUseErrorActionPreference=$false; $mearlExit=1"
    + "; try { & (Get-Process -Id $PID).Path -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand '"
    + encoded + "'; $mearlExit=$LASTEXITCODE } catch { [Console]::WriteLine([string]$_) }; ";
  const osc = "[Console]::Write(([string][char]27) + ']6973;' + '" + id + "' + ";
  return {
    buffer: '& { ' + osc + "';start' + [char]7)" + body
      + osc + "';' + $mearlExit + [char]7) }\r",
    screen: "& { [Console]::WriteLine(); [Console]::WriteLine(('[+{0}]' -f '" + token + "'))" + body
      + "[Console]::WriteLine(); [Console]::WriteLine(('[-{0}:{1}]' -f '" + token + "', $mearlExit)) }\r",
  };
}

export function wrapScript(script, id, shell) {
  if (!['posix', 'powershell'].includes(shell)) throw new Error('shell 支持 posix 或 powershell');
  if (typeof script !== 'string') throw new Error('script 必须是非空脚本');
  script = script.replaceAll('\r\n', '\n');
  if (!script.trim() || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(script)) {
    throw new Error('script 必须是非空脚本，可包含换行和制表符');
  }
  // Compact visible markers fit in a narrow split pane.
  const token = id.replaceAll('-', '').slice(-16);
  const commands = shell === 'posix' ? wrapPosix(script, id, token) : wrapPowerShell(script, id, token);
  if (Object.values(commands).some(line => Buffer.byteLength(line) > 3800)) {
    throw new Error('脚本编码后超出终端输入长度限制');
  }
  return { ...commands, screenMarkers: { start: '[+' + token + ']', end: '[-' + token + ':' } };
}

/** The narrow native-input contract for session-only model/effort controls. */
export interface NativeModelSettingsLease {
  current(): boolean;
  capture(): Promise<string>;
  write(input: string): Promise<boolean>;
  /** Cancel only the menu opened by this operation before releasing held keyboard input. */
  cancelMenu(): Promise<void>;
}

export function isNativeModelSettingsInput(input: string): boolean {
  return (
    input === '\x1b' ||
    input === 's' ||
    input === '/status\r' ||
    (input.length === 3 && input.charCodeAt(0) === 27 && input[1] === '[' && 'ABCD'.includes(input[2])) ||
    /^\/model(?: [A-Za-z0-9][A-Za-z0-9._:/-]{0,95}| --reasoning=(?:none|minimal|low|medium|high|xhigh|max|ultra))?\r$/.test(
      input
    )
  );
}

let leases = 0;

/** A worker restart must not make another operation destroy active offscreen work. */
export function holdOffscreenDocument(): () => void {
  leases++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    leases--;
  };
}
export function hasOffscreenWork(): boolean {
  return leases > 0;
}

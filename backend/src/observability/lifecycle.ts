/**
 * Process lifecycle flag. On SIGTERM the process first flips to "draining": /ready starts answering 503 so the load
 * balancer stops sending NEW requests, and only after a short delay does it close the server and let in-flight requests
 * finish. Without this step a rolling deploy drops the requests that arrive between "SIGTERM" and "removed from the LB".
 */
let draining = false;
export const startDraining = () => { draining = true; };
export const isDraining = () => draining;
/** Test hook. */
export const resetLifecycleForTests = () => { draining = false; };

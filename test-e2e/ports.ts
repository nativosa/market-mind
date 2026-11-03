/** Loopback ports of the E2E servers (test-e2e/server.ts): the app, the test control port, Vite dev and the synthetic demo. */
export const E2E_PORTS = { web: 4417, control: 4418, dev: 4419, demo: 4420 } as const;

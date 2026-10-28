// Offline guarantee: any accidental real network call fails loudly.
globalThis.fetch = () => {
  throw new Error("Network access is forbidden in offline tests; inject a fake fetch instead.");
};

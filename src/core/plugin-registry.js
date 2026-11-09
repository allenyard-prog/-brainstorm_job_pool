export async function loadPlugin(site, transport, { write = false } = {}) {
  let module;
  try { module = await import(`../../plugins/${site}/index.js`); }
  catch (error) { throw new Error(`Cannot load site plugin '${site}': ${error.message}`); }
  const definition = module.default;
  if (definition?.id !== site || !definition.capabilities) throw new Error(`Plugin '${site}' has invalid metadata.`);
  const plugin = definition.transports[transport];
  if (!plugin) throw new Error(`Plugin '${site}' does not support '${transport}'.`);
  if (write && !['markAsApplied', 'getApplicationStatus'].every(method => definition.capabilities.operations.includes(method))) {
    throw new Error(`Plugin '${site}' does not support verified status updates. Use --read-only.`);
  }
  for (const method of ['authenticate', 'listJobs', 'getJobDetails', 'markAsApplied', 'getApplicationStatus']) {
    if (typeof plugin[method] !== 'function') throw new Error(`Plugin '${site}' is missing ${method}.`);
  }
  return plugin;
}

export async function listSites(sites = ['jobright']) {
  return Promise.all(sites.map(async site => {
    if (!/^[a-z][a-z0-9-]*$/.test(site)) throw new Error('Invalid plugin ID.');
    const { default: definition } = await import(`../../plugins/${site}/index.js`);
    if (definition.id !== site || !definition.capabilities) throw new Error(`Plugin '${site}' has invalid metadata.`);
    return { id: definition.id, name: definition.name, transports: definition.capabilities.transports,
      operations: definition.capabilities.operations };
  }));
}

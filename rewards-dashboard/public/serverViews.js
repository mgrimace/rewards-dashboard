export function accountKey(serverId, accountKey) {
  return JSON.stringify([serverId, accountKey]);
}

export function combineAccounts(groups) {
  const histories = {};
  const accounts = groups.flatMap((group) => (group.accounts?.accounts || []).map((account) => {
    const key = accountKey(group.server.id, account.key);
    histories[key] = group.accounts.histories?.[account.key] || [];
    return {
      ...account, key, serverId: group.server.id,
      serverName: `${group.server.name}${group.server.deletedAt ? " (removed)" : group.archived ? " (disabled)" : ""}`,
      archived: group.archived,
    };
  }));
  return { accounts, histories };
}

export function accountTotals(accounts) {
  return {
    count: accounts.length,
    balance: accounts.reduce((sum, account) => sum + (account.lastPoints || 0), 0),
  };
}

export async function loadServers(api, fields, { historical = false } = {}) {
  const { connections } = await api.connections(historical);
  const servers = connections.filter((server) => historical || server.enabled);
  return Promise.all(servers.map(async (server) => {
    const archived = !server.enabled || Boolean(server.deletedAt);
    const client = api.forServer(server.id, archived);
    const results = await Promise.allSettled(fields.map((field) =>
      field === "accounts" && archived ? client.accounts("all")
        : field === "activityDays" && archived ? client.activityDays("all")
          : client[field]()));
    const group = { server, archived, errors: [] };
    results.forEach((result, index) => {
      if (result.status === "fulfilled") group[fields[index]] = result.value;
      else group.errors.push(`${fields[index]}: ${result.reason.message}`);
    });
    return group;
  }));
}

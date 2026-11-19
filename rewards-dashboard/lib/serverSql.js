"use strict";

function serverSql(db, serverId) {
  const filter = serverId === null ? "1 = 1" : "server_id = $serverId";
  const serverColumn = serverId === null ? "" : "server_id, ";
  const serverValue = serverId === null ? "" : "$serverId, ";
  const prepare = (sql) => {
    const stmt = db.prepare(sql);
    if (serverId === null) return stmt;
    return {
      get: (...args) => stmt.get({ $serverId: serverId }, ...args),
      all: (...args) => stmt.all({ $serverId: serverId }, ...args),
      run: (...args) => stmt.run({ $serverId: serverId }, ...args),
    };
  };
  return { filter, serverColumn, serverValue, prepare };
}

module.exports = { serverSql };

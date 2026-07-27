/**
 * KWin script — non-interactive active window + open windows dump.
 * NEVER call org.kde.KWin.queryWindowInfo (interactive mouse grab).
 *
 * Plasma 6 dbus-loaded scripts often lack writeConfig. Prefer printing a
 * single JSON line that the Node sense side scrapes from the journal, and
 * also try writeConfig when available (older / packaged KWin scripts).
 */
(function () {
  function safe(v) {
    return String(v == null ? "" : v).replace(/[\n\r\t]/g, " ").slice(0, 240);
  }

  var w = workspace.activeWindow || workspace.activeClient;
  var payload = {
    caption: w ? safe(w.caption) : "",
    resourceClass: w ? safe(w.resourceClass) : "",
    resourceName: w ? safe(w.resourceName) : "",
    pid: w ? Number(w.pid || 0) : 0,
    desktopFile: "",
    updatedAt: Date.now(),
    windows: [],
  };
  try {
    payload.desktopFile = w ? safe(w.desktopFileName) : "";
  } catch (e) {}

  try {
    var clients = workspace.windowList
      ? workspace.windowList()
      : workspace.clientList
        ? workspace.clientList()
        : [];
    for (var i = 0; i < clients.length && payload.windows.length < 12; i++) {
      var c = clients[i];
      if (!c) continue;
      try {
        if (c.deleted) continue;
      } catch (e1) {}
      try {
        if (c.skipTaskbar || c.skipPager) continue;
      } catch (e2) {}
      var cap = safe(c.caption);
      var cls = safe(c.resourceClass);
      var cpid = Number(c.pid || 0);
      if (!cap && !cls) continue;
      payload.windows.push({ title: cap, app: cls, pid: cpid });
    }
  } catch (e3) {}

  if (typeof writeConfig === "function") {
    try {
      writeConfig("caption", payload.caption);
      writeConfig("resourceClass", payload.resourceClass);
      writeConfig("resourceName", payload.resourceName);
      writeConfig("pid", String(payload.pid || 0));
      writeConfig("desktopFile", payload.desktopFile);
      writeConfig("updatedAt", String(payload.updatedAt));
      var lines = [];
      for (var j = 0; j < payload.windows.length; j++) {
        var row = payload.windows[j];
        lines.push(row.title + "\t" + row.app + "\t" + String(row.pid || 0));
      }
      writeConfig("windows", lines.join("\n"));
    } catch (e4) {}
  }

  if (typeof print === "function") {
    print("COMPANION_FOCUS_JSON:" + JSON.stringify(payload));
  }
})();

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companionOrb", {
  setBalloon(open) {
    ipcRenderer.send("orb:balloon", Boolean(open));
  },
  arm() {
    ipcRenderer.send("orb:arm");
  },
  drag(screenX, screenY, offsetX, offsetY) {
    ipcRenderer.send("orb:drag", { screenX, screenY, offsetX, offsetY });
  },
  dragEnd() {
    ipcRenderer.send("orb:drag-end");
  },
});

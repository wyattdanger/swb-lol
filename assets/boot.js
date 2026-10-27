// Loads this draft's data.json (it sits next to the page) and starts the viewer.
function draftDataUrl(pathname) {
  return (pathname.endsWith("/") ? pathname : pathname + "/") + "data.json";  // /drafts/1 and /drafts/1/ both work
}

async function boot() {
  try {
    const res = await fetch(draftDataUrl(location.pathname));
    if (!res.ok) throw new Error("HTTP " + res.status);
    startViewer(await res.json());
  } catch (e) {
    document.getElementById("app").textContent = "Could not load this draft (" + e.message + ").";
  }
}

if (typeof module !== "undefined") module.exports = { draftDataUrl, boot };  // lets the specs load this file
else boot();

/* boot.js — loaded last: app initialisation after every module is in scope. */
async function init() {
  document.getElementById("conninfo").textContent = "postgres://localhost:5432";
  builderMode("create");
  if (!document.querySelector("[data-coldef]")) addColRow("id", "BIGSERIAL");
  if (localStorage.getItem("pgal_histopen")) { document.getElementById("histdrawer").classList.remove("hidden"); document.getElementById("histdrawer").classList.add("flex"); renderHistory(); }
  await loadDatabases();
}
(async () => {
  if (!token) return showLogin();
  try { await api("/api/databases"); document.getElementById("login").style.display = "none"; init(); }
  catch { /* 401 already routed to showLogin */ }
})();

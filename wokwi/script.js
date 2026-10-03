// CONFIGURATION MQTT
//    Connexion au broker HiveMQ par WebSocket sécurisé.
//    Les topics DATA, EVENT et CMD doivent correspondre à l'ESP32.

const BROKER = "wss://broker.hivemq.com:8884/mqtt";
const T_DATA = "eic30/innovators/irrigation/data";
const T_EVENT = "eic30/innovators/irrigation/event";
const T_CMD = "eic30/innovators/irrigation/cmd";

// Seuils d'humidité utilisés par le fonctionnement automatique.
const ON_T = 30, OFF_T = 50;

// Raccourci pour récupérer un élément HTML par son identifiant.
const $ = id => document.getElementById(id);

// État courant du système et variables utilisées par le mode démo.
let curMode = "AUTO", alertMsg = "", dSoil = 60, dPump = false, dStart = 0;

// Historique, cycle ouvert, données du graphique et connexion MQTT.
let history = load(), openCycle = null, points = [], demo = false, demoTimer = null, lastMsg = 0, client = null;

function load(){ 
    try { 
        return JSON.parse(localStorage.getItem("irrig_history")) || []; 
    } catch(e){ 
        return []; 
    } 
}

function save(){ 
    try { 
        localStorage.setItem("irrig_history", JSON.stringify(history)); 
    } catch(e){} 
}

function setStatus(txt, cls){ 
    const s = $("status"); 
    s.textContent = txt; 
    s.className = "badge " + (cls || ""); 
}

// Fonctions utilitaires pour formater les dates et les durées.
const fmt = ts => ts ? new Date(ts).toLocaleString("fr-FR") : "—";

function secs(a, b){ 
    return a ? Math.round((b - a) / 1000) : null; 
}

function human(s){
    if (s === null) return "—"; return s < 60 ? s + " s" : Math.floor(s/60) + " min " + (s%60) + " s"; }

function setBanner(cls, title, text){
    $("banner").className = cls; 
    $("bTitle").textContent = title; 
    $("bText").textContent = text; 
}

function updateBanner(soil, on){
    if (alertMsg && !on) setBanner("alert", "Arrêt de sécurité", alertMsg);
    else if (on) setBanner("pump", "La pompe arrose", "Le sol était sec (sous " + ON_T + " %). L'arrosage s'arrête à " + OFF_T + " %.");
    else if (soil >= OFF_T) setBanner("good", "Le sol est bien humide", "Pas besoin d'arroser pour le moment.");
    else setBanner("watch", "Le sol est correct, mais à surveiller", "La pompe démarrera si l'humidité passe sous " + ON_T + " %.");
}


//    TRAITEMENT DES MESURES
//    Met à jour les valeurs, la jauge, la pompe et le graphique.

function handleData(d){
    lastMsg = Date.now();
    const soil = Number(d.hum_sol), on = d.pump === "ON";
    setMode(d.mode || "AUTO");
    $("temp").textContent = Number(d.temp).toFixed(1);
    $("air").textContent = Number(d.hum_air).toFixed(0);
    $("soil").textContent = soil;
    $("fill").style.height = Math.max(0, Math.min(100, soil)) + "%";
    const p = $("pump");
    p.textContent = on ? "Pompe : en marche" : "Pompe : arrêtée";
    p.className = "pump" + (on ? " on" : "");
    updateBanner(soil, on);
    points.push(soil); if (points.length > 60) points.shift();
    drawChart();
}


//    ÉVÉNEMENTS D'ARROSAGE
//    START ouvre un cycle ; STOP le termine et l'enregistre.
   
function handleEvent(e){
    if (e.event === "START") { 
        alertMsg = ""; 
        openCycle = { 
            start: Date.now(), 
            soilStart: e.hum_sol, 
            mode: e.mode 
        }; 
    }
    else if (e.event === "STOP") {
        history.unshift({ start: openCycle ? openCycle.start : null, end: Date.now(),
        soilStart: openCycle ? openCycle.soilStart : null, soilEnd: e.hum_sol,
        mode: openCycle ? openCycle.mode : null, reason: e.reason });
        if (e.reason === "timeout") alertMsg = "La pompe a atteint sa durée maximale et a été coupée. Vérifie le capteur d'humidité ou l'arrivée d'eau.";
        history = history.slice(0, 100); 
        openCycle = null; save(); 
        renderHistory();
    }
}

// Reconstruit le tableau de l'historique et calcule la durée totale.
function renderHistory(){
    $("rows").innerHTML = history.map(h => `<tr><td>${fmt(h.start)}</td><td>${fmt(h.end)}</td><td>${human(secs(h.start, h.end))}</td><td>${h.mode === "MANUAL" ? "Manuel" : h.mode === "AUTO" ? "Auto" : "—"}</td><td>${h.soilStart ?? "—"} % → ${h.soilEnd} %</td><td>${REASONS[h.reason] || "—"}</td></tr>`).join("");
    $("empty").style.display = history.length ? "none" : "block";
    const total = history.reduce((a, h) => a + (secs(h.start, h.end) || 0), 0);
    $("sum").textContent = history.length ? history.length + " arrosage(s) enregistré(s), durée totale : " + human(total) : "";
}


//    GRAPHIQUE D'HUMIDITÉ
//    Dessine les seuils puis les 60 dernières mesures reçues.

function drawChart(){
    const c = $("chart"), w = c.width = c.clientWidth, h = c.height = c.clientHeight, g = c.getContext("2d");
    const css = getComputedStyle(document.documentElement);
    g.clearRect(0, 0, w, h);
    const y = v => h - 6 - (v / 100) * (h - 12);
    g.setLineDash([5, 5]); g.strokeStyle = css.getPropertyValue("--soil"); g.lineWidth = 1;
    [ON_T, OFF_T].forEach(v => { g.beginPath(); g.moveTo(0, y(v)); g.lineTo(w, y(v)); g.stroke(); });
    g.setLineDash([]);
    if (points.length < 2) return;
    g.strokeStyle = css.getPropertyValue("--water"); g.lineWidth = 2.5; g.beginPath();
    points.forEach((v, i) => { const x = i / (points.length - 1) * w; i ? g.lineTo(x, y(v)) : g.moveTo(x, y(v)); });
    g.stroke();
}



//    CONNEXION MQTT
//    Connexion, reconnexion automatique et réception des messages.
  

// Établit la connexion au broker et s'abonne aux topics DATA et EVENT.
function connect(){
    if (typeof mqtt === "undefined") { 
        setStatus("Bibliothèque MQTT non chargée (vérifie Internet)"); 
        return; 
    }
    client = mqtt.connect(BROKER, { reconnectPeriod: 3000, clientId: "dash-" + Math.random().toString(16).slice(2, 8) });
    client.on("connect", () => { if(!demo) setStatus("Connecté au broker", "ok"); client.subscribe([T_DATA, T_EVENT]); });
    client.on("close", () => { if(!demo) setStatus("Déconnecté, nouvelle tentative…"); });
    client.on("message", (topic, msg) => {
        if (demo) return;
        let o; 
        try { 
            o = JSON.parse(msg.toString()); 
        } catch(e) { 
            return; 
        }
        topic === T_DATA ? handleData(o) : handleEvent(o);
    });
}


//    COMMANDES MQTT
//    Envoie AUTO, MANUAL, PUMP_ON ou PUMP_OFF à l'ESP32.

// Traduction des raisons d'arrêt affichées dans l'historique.
const REASONS = { 
    normal: "Seuil atteint", 
    manuel: "Arrêt manuel", 
    timeout: "Sécurité (durée max)" 
};

// Met à jour le mode et active/désactive les boutons manuels.
function setMode(m){
  curMode = m;
  $("mAuto").classList.toggle("act", m === "AUTO"); $("mMan").classList.toggle("act", m === "MANUAL");
  $("bOn").disabled = $("bOff").disabled = (m === "AUTO");
  $("ctlMsg").textContent = m === "AUTO" ? "Mode automatique : les boutons Arroser et Arrêter sont désactivés." : "Mode manuel : l'arrosage s'arrête seul après 30 secondes.";
}

// Envoie une commande MQTT ou la simule lorsque le mode démo est actif.
function sendCmd(cmd){
  if (demo) return demoCmd(cmd);
  if (client && client.connected) client.publish(T_CMD, cmd);
  else $("ctlMsg").textContent = "Commande non envoyée : le dashboard n'est pas connecté au broker.";
}



//    MODE DÉMO
//    Génère des données locales pour tester l'interface sans Wokwi.

function demoStart(mode){ 
    dPump = true; 
    dStart = Date.now(); 
    handleEvent({ event: "START", mode: mode, hum_sol: dSoil }); 
}

function demoStop(reason){ 
    if (!dPump) return; 
    dPump = false; 
    handleEvent({ event: "STOP", reason: reason, hum_sol: dSoil }); 
}

// Reproduit localement les commandes normalement envoyées à l'ESP32.
function demoCmd(cmd){
    if (cmd === "AUTO" || cmd === "MANUAL") { 
        demoStop("manuel"); setMode(cmd); 
    }
    else if (cmd === "PUMP_ON" && curMode === "MANUAL" && !dPump) demoStart("MANUAL");
    else if (cmd === "PUMP_OFF" && curMode === "MANUAL") demoStop("manuel");
}

// Active ou désactive la génération périodique de données simulées.
function toggleDemo(){
  demo = !demo;
  $("demoBtn").textContent = demo ? "Quitter le mode démo" : "Mode démo";
  if (!demo) { clearInterval(demoTimer); lastMsg = 0; alertMsg = ""; setStatus(client && client.connected ? "Connecté au broker" : "Déconnecté", client && client.connected ? "ok" : ""); setBanner("", "En attente des données", "Lance la simulation Wokwi : les mesures apparaîtront ici."); return; }
  setStatus("Mode démo : données simulées", "demo");
  dSoil = 60; dPump = false; setMode("AUTO");
  demoTimer = setInterval(() => {
    dSoil += dPump ? 7 : -3; dSoil = Math.max(0, Math.min(100, Math.round(dSoil + (Math.random() * 2 - 1))));
    if (curMode === "AUTO") {
      if (!dPump && dSoil < ON_T) demoStart("AUTO");
      else if (dPump && dSoil >= OFF_T) demoStop("normal");
    }
    if (dPump && curMode === "MANUAL" && Date.now() - dStart > 30000) demoStop("timeout");
    handleData({ temp: 24 + Math.random(), hum_air: 40 + Math.random() * 3, hum_sol: dSoil, pump: dPump ? "ON" : "OFF", mode: curMode });
  }, 1000);
}


//    ÉVÉNEMENTS DE L'INTERFACE
//    Associe les boutons HTML aux fonctions correspondantes.
   
$("demoBtn").onclick = toggleDemo;
$("mAuto").onclick = () => { 
    setMode("AUTO"); 
    sendCmd("AUTO"); 
};

$("mMan").onclick = () => { 
    setMode("MANUAL"); 
    sendCmd("MANUAL"); 
};

$("bOn").onclick = () => sendCmd("PUMP_ON");
$("bOff").onclick = () => sendCmd("PUMP_OFF");
setMode("AUTO");
$("clearBtn").onclick = () => { 
    history = []; 
    save(); 
    renderHistory(); 
};

setInterval(() => {
    if (!lastMsg) { 
        $("age").textContent = "Aucune donnée"; 
        return; 
    }
    const s = Math.round((Date.now() - lastMsg) / 1000);
    $("age").textContent = "Dernière donnée il y a " + s + " s";
  if (!demo && s > 10) setBanner("", "Plus de données reçues", "Vérifie que la simulation Wokwi tourne et que sa fenêtre reste visible.");
}, 1000);

// Redessine le graphique lorsque la fenêtre change de taille.
window.addEventListener("resize", drawChart);

// Initialisation du dashboard au chargement de la page.
renderHistory(); drawChart(); connect();

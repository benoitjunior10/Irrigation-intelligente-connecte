#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>

// BROCHES
#define DHTPIN     4      // DHT22 sur GPIO 4
#define DHTTYPE    DHT22
#define RELAY_PIN  5      // Relais sur GPIO 5
#define SOIL_PIN   34     // Potentiomètre (humidité du sol) sur GPIO 34

// SEUILS
#define SOIL_ON_THRESHOLD   30        // Pompe ON si humidité sol < 30 %
#define SOIL_OFF_THRESHOLD  50        // Pompe OFF si humidité sol >= 50 %
#define MANUAL_MAX_MS       30000UL   // Arrosage manuel : 30 s maximum
#define AUTO_MAX_MS         60000UL   // Arrosage auto : 60 s maximum (sécurité)

// WI-FI (Wokwi)
const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASS = "";

// MQTT
const char* MQTT_SERVER = "broker.hivemq.com";
const int   MQTT_PORT   = 1883;
const char* TOPIC_DATA  = "eic30/innovators/irrigation/data";
const char* TOPIC_EVENT = "eic30/innovators/irrigation/event";
const char* TOPIC_CMD   = "eic30/innovators/irrigation/cmd";   // commandes du dashboard

// OBJETS
DHT dht(DHTPIN, DHTTYPE);
WiFiClient espClient;
PubSubClient client(espClient);

// ETAT
bool autoMode = true;        // true = AUTO, false = MANUEL
bool pumpOn = false;
bool pumpManual = false;     // le cycle en cours a été lancé en manuel
bool autoLocked = false;     // auto bloqué après un arrêt de sécurité
unsigned long pumpStart = 0;
int lastSoil = 0;
float lastTemp = 0;
float lastHum  = 0;
unsigned long lastReadTime = 0;
const unsigned long READ_INTERVAL = 2000;

// Connexion Wi-Fi
void connectWiFi() {
    Serial.print("Connexion WiFi");
    WiFi.begin(WIFI_SSID, WIFI_PASS, 6);
    while (WiFi.status() != WL_CONNECTED) {
        delay(250);
        Serial.print(".");
    }
    Serial.println();
    Serial.println("WiFi connecté");
}

// Connexion MQTT
void connectMQTT() {
    while (!client.connected()) {
        Serial.print("Connexion MQTT...");
        String clientId = "esp32-irrigation-" + String(random(0xffff), HEX);
        if (client.connect(clientId.c_str())) {
            Serial.println(" MQTT connecté");
            client.subscribe(TOPIC_CMD);     // ecouter les commandes du dashboard
        } else {
            Serial.print(" échec, code=");
            Serial.print(client.state());
            Serial.println(" -> nouvel essai dans 2 s");
            delay(2000);
        }
    }
}

// Evenements (pour l'historique du dashboard)
void publishStart(const char* mode) {
    char msg[120];
    snprintf(msg, sizeof(msg),
            "{\"event\":\"START\",\"mode\":\"%s\",\"hum_sol\":%d,\"uptime\":%lu}",
            mode, lastSoil, millis() / 1000);
    client.publish(TOPIC_EVENT, msg);
    Serial.print("Evenement publié: ");
    Serial.println(msg);
}

void publishStop(const char* reason) {
    char msg[120];
    snprintf(msg, sizeof(msg),
            "{\"event\":\"STOP\",\"reason\":\"%s\",\"hum_sol\":%d,\"uptime\":%lu}",
            reason, lastSoil, millis() / 1000);
    client.publish(TOPIC_EVENT, msg);
    Serial.print("Evenement publié: ");
    Serial.println(msg);
}

// Commande de la pompe
void startPump(bool manual) {
    if (pumpOn) return;
    pumpOn = true;
    pumpManual = manual;
    pumpStart = millis();
    digitalWrite(RELAY_PIN, HIGH);
    Serial.println(manual ? "Pompe ON (manuel)" : "Sol sec -> Pompe ON (auto)");
    publishStart(manual ? "MANUAL" : "AUTO");
}

// reason : "normal" (seuil atteint), "manuel" (arrêt demandé), "timeout" (sécurité)
void stopPump(const char* reason) {
    if (!pumpOn) return;
    pumpOn = false;
    digitalWrite(RELAY_PIN, LOW);
    Serial.print("Pompe OFF (");
    Serial.print(reason);
    Serial.println(")");
    publishStop(reason);
}

// Reception des commandes MQTT
// Commandes : AUTO, MANUAL, PUMP_ON, PUMP_OFF
void onMessage(char* topic, byte* payload, unsigned int length) {
    String cmd = "";
    for (unsigned int i = 0; i < length; i++) cmd += (char)payload[i];
    cmd.trim();
    Serial.print("Commande reçue: ");
    Serial.println(cmd);

    if (cmd == "AUTO") {
        stopPump("manuel");        // securite : on repart d'une pompe arrêtée
        autoMode = true;
        autoLocked = false;
    } else if (cmd == "MANUAL") {
        stopPump("manuel");
        autoMode = false;
    } else if (cmd == "PUMP_ON" && !autoMode) {
        startPump(true);
    } else if (cmd == "PUMP_OFF" && !autoMode) {
        stopPump("manuel");
    }
}

void setup() {
    Serial.begin(115200);
    dht.begin();
    pinMode(RELAY_PIN, OUTPUT);
    digitalWrite(RELAY_PIN, LOW);   // Pompe éteinte au démarrage

    connectWiFi();
    client.setServer(MQTT_SERVER, MQTT_PORT);
    client.setCallback(onMessage);
    client.setKeepAlive(60);        // connexion plus tolérante
    connectMQTT();
}

void loop() {
    if (WiFi.status() != WL_CONNECTED) connectWiFi();
    if (!client.connected()) connectMQTT();
    client.loop();

    // Sécurité : vérifiée à chaque passage, pas seulement toutes les 2 s
    if (pumpOn) {
        unsigned long limit = pumpManual ? MANUAL_MAX_MS : AUTO_MAX_MS;
        if (millis() - pumpStart >= limit) {
            stopPump("timeout");
            if (!pumpManual) autoLocked = true;   // pas de redémarrage auto en boucle
        }
    }

    unsigned long now = millis();
    if (now - lastReadTime < READ_INTERVAL) return;
    lastReadTime = now;

    // 1. DHT22 (garder la dernière valeur valide si erreur)
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (isnan(t) || isnan(h)) {
        Serial.println("Erreur lecture DHT22 -> dernière valeur gardée");
    } else {
        lastTemp = t;
        lastHum  = h;
    }

    // 2. Humidité du sol (potentiomètre)
    int soilRaw = analogRead(SOIL_PIN);
    lastSoil = map(soilRaw, 0, 4095, 0, 100);

    // 3. Mode automatique : décision selon les seuils
    if (lastSoil >= SOIL_ON_THRESHOLD) autoLocked = false;   // capteur revenu à la normale
    if (autoMode) {
        if (!pumpOn && lastSoil < SOIL_ON_THRESHOLD && !autoLocked) {
            startPump(false);
        } else if (pumpOn && !pumpManual && lastSoil >= SOIL_OFF_THRESHOLD) {
            stopPump("normal");
        }
    }

    // 4. Moniteur série
    Serial.print("Mode: ");           Serial.print(autoMode ? "AUTO" : "MANUEL");
    Serial.print(" | Temp: ");        Serial.print(lastTemp);
    Serial.print(" C | Humidité air: "); Serial.print(lastHum);
    Serial.print(" % | Humidité sol: "); Serial.print(lastSoil);
    Serial.print(" % | Pompe: ");     Serial.println(pumpOn ? "ON" : "OFF");

    // 5. Publication MQTT
    char payload[200];
    snprintf(payload, sizeof(payload),
            "{\"temp\":%.1f,\"hum_air\":%.1f,\"hum_sol\":%d,\"pump\":\"%s\",\"mode\":\"%s\",\"uptime\":%lu}",
            lastTemp, lastHum, lastSoil, pumpOn ? "ON" : "OFF",
            autoMode ? "AUTO" : "MANUAL", now / 1000);
    client.publish(TOPIC_DATA, payload);
}

// ==========================================
// CHAUFFE-EAU - AUTO / FORCE / ARRET
// Shelly 1 Gen4
// ==========================================

let mode = Virtual.getHandle("enum:200");

if (!mode) {
  console.log("ERREUR : enum:200 introuvable");
  throw new Error("enum:200 introuvable");
}

// Dernier état connu du Linky
let previousLinkyHC = null;

// ------------------------------------------------
// Commande du relais en fonction du mode
// ------------------------------------------------
function updateRelay() {
  let modeValue = mode.getValue();

  // Lecture de l'état du Linky sur SW
  let inputStatus = Shelly.getComponentStatus("input", 0);

  if (!inputStatus) {
    console.log("ERREUR : impossible de lire input:0");
    return;
  }

  let linkyHC = inputStatus.state === true;
  let relayOn = false;

  if (modeValue === "auto") {
    // AUTO = suit le Linky
    relayOn = linkyHC;
  }
  else if (modeValue === "force") {
    // FORCÉ = toujours ON
    relayOn = true;
  }
  else if (modeValue === "arret") {
    // ARRÊT = toujours OFF
    relayOn = false;
  }

  Shelly.call("Switch.Set", {
    id: 0,
    on: relayOn
  });

  console.log(
    "Mode:", modeValue,
    "| Linky HC:", linkyHC,
    "| Chauffe-eau:", relayOn ? "ON" : "OFF"
  );
}

// ------------------------------------------------
// Changement du mode AUTO / FORCÉ / ARRÊT
// ------------------------------------------------
mode.on("change", function(event) {
  console.log("Nouveau mode :", event.value);
  updateRelay();
});

// ------------------------------------------------
// Changement de l'état Linky sur SW
// ------------------------------------------------
Shelly.addStatusHandler(function(status) {
  if (status.component === "input:0") {
    let linkyHC = status.delta.state === true;

    // Détection du passage HP -> HC
    if (
      previousLinkyHC === false &&
      linkyHC === true
    ) {
      let currentMode = mode.getValue();

      // Si on était en marche forcée,
      // on repasse automatiquement en AUTO
      if (currentMode === "force") {
        console.log(
          "Passage HP -> HC détecté : FORCÉ -> AUTO"
        );

        mode.setValue("auto");

        // updateRelay() sera appelé par mode.on("change")
        previousLinkyHC = linkyHC;
        return;
      }
    }

    // Mémorisation de l'état Linky
    previousLinkyHC = linkyHC;

    updateRelay();
  }
});

// ------------------------------------------------
// Au démarrage du script
// ------------------------------------------------
let initialInput = Shelly.getComponentStatus("input", 0);

if (initialInput) {
  previousLinkyHC = initialInput.state === true;
}

updateRelay();

console.log("Gestion chauffe-eau démarrée");

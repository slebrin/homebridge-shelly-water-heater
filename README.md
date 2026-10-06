# homebridge-shelly-water-heater

Interface HomeKit pour un chauffe-eau piloté par un Shelly 1 Gen4, avec Node.js 24
et Homebridge 1.8+ ou 2.x. Aucun module de production supplémentaire : `fetch`
et `WebSocket` sont ceux de Node.js.

**Le Shelly reste le cerveau.** Le plugin écrit uniquement `Enum.Set` pour
`enum:200`. Il lit `Enum.GetStatus` et `Switch.GetStatus`, et n'appelle jamais
`Switch.Set`. Il ne lit pas l'entrée Linky, ne gère pas HP/HC, Tempo ou les horaires,
et ne réalise pas la transition Force vers Auto. Aucun MQTT.

## Représentation dans Apple Maison

Un seul accessoire externe nommé **Chauffe-eau** :

- Un service `Television` avec exactement trois `InputSource` liés :
  Arrêt, Auto, Marche forcée. Les noms viennent de `states` dans la configuration
  via `ConfiguredName`. Identifiants stables : 1 = arret, 2 = auto, 3 = force.
- Un service `Switch` nommé **Chauffe-eau - En chauffe**. Son `On` reflète seulement
  le booléen `output` de `switch:0` : ON = relais fermé, OFF = relais ouvert.
  Permissions HAP : lecture et notifications, **sans écriture**. Une tentative
  d'écriture réseau est rejetée par HAP avec `READ_ONLY_CHARACTERISTIC`.

### Limites à connaître

- L'accessoire utilise l'interface **TV**, pas un thermostat. Le bouton alimentation
  TV n'est pas l'indicateur de chauffe : il reste actif pour que le sélecteur de
  sources soit accessible, y compris en mode Arrêt. L'extinction TV est refusée;
  sélectionner **Arrêt** pour changer le mode. Les touches télécommande sont refusées.
- Maison peut afficher le Switch comme touchable, même en lecture seule.
  Un appui peut provoquer une erreur ou un affichage optimiste temporaire.
  **Il ne peut pas commander le relais.** Ne pas compter sur un bouton grisé.
- Un accessoire HAP ne signifie pas forcément une seule tuile dans Maison.
  Le regroupement et l'affichage des services TV + Switch dépendent de la version
  de Maison. Le plugin ne garantit pas deux contrôles dans une seule tuile.
- `ConfiguredName` permet les noms de sources, mais Maison peut les mettre en
  cache ou les renommer. Les renommages dans Maison sont acceptés pendant la
  session; la configuration est réappliquée au redémarrage. Des versions de tvOS
  ont également présenté un bug remplaçant les noms par « Input Source N ».
- L'état indiqué est **l'état du relais**, pas une mesure de courant ou de
  température : relais ON ne prouve pas que la résistance consomme effectivement.
- Le rendu exact dans votre version d'iOS doit être validé sur un iPhone réel.
  Les tests automatiques vérifient les services, permissions et données HAP,
  pas l'interface propriétaire d'Apple.

Pourquoi pas `SecuritySystem` ? HAP permet `validValues: [0, 1, 3]` pour exclure
Night, mais Maison garde les intitulés Apple. Les états sont Stay=0, Away=1,
Night=2, Disarmed=3; CurrentState inclut aussi AlarmTriggered=4. Aucun de ces états
ne représente correctement le relais. `HeaterCooler` nécessiterait notamment
une température réelle et des commandes de thermostat; aucune température n'est
inventée ici. Aucun ContactSensor n'est exposé.

## Préparation du Shelly

Un composant virtuel de type Enum doit **déjà exister** sur le Shelly sous
l'identifiant `enum:200`. Dans l'installation documentée, il est persistant,
sa valeur par défaut est `auto` et ses options techniques exactes sont `auto`,
`force`, `arret`.
Le plugin ne crée ni ne reconfigure de composant et ne touche pas au script.
Le Shelly doit être accessible en HTTP/WebSocket sur le réseau local.

Le [script Shelly et son guide](./shelly/README.md) sont disponibles dans le dépôt
[GitHub](https://github.com/slebrin/homebridge-shelly-water-heater/tree/main/shelly).
Ils documentent la logique existante et son installation manuelle; le plugin
ne les exécute pas. Le câblage du contacteur reste à valider selon le matériel exact.

Cette version ne prend pas en charge l'authentification Digest Shelly :
un appareil protégé renvoie une erreur explicite et apparaît indisponible,
sans commande envoyée après cet échec. À utiliser uniquement sur un réseau local
de confiance et adapté à cette configuration; ne pas exposer le Shelly à Internet.

## Installation locale

Depuis ce dossier :

```sh
npm ci
npm test
npm pack
```

Installer le fichier `homebridge-shelly-water-heater-1.0.0.tgz` sur la machine
Homebridge, par exemple avec :

```sh
npm install -g ./homebridge-shelly-water-heater-1.0.0.tgz
```

Utiliser le compte et le préfixe npm employés par votre installation Homebridge.
Le paquet n'est pas encore publié sur npm : il n'est pas trouvable par recherche
dans l'UI tant qu'il n'a pas été publié. Une fois installé, le schéma fournit
les champs de configuration dans Homebridge UI.

Ajouter dans `platforms` de la configuration existante :

```json
{
  "platform": "ShellyWaterHeater",
  "name": "Chauffe-eau",
  "host": "192.168.1.235",
  "enumId": 200,
  "switchId": 0,
  "pollInterval": 10,
  "states": {
    "arret": "Arrêt",
    "auto": "Auto",
    "force": "Marche forcée"
  }
}
```

Contrairement à l'exemple initial en `accessories`, il s'agit d'une **platform** :
Homebridge publie les téléviseurs comme accessoires externes pour l'appairage
HomeKit. Voir aussi [config.example.json](./config.example.json). Ne pas remplacer
toute votre configuration par l'exemple.

Redémarrer Homebridge, puis dans Maison : **Ajouter un accessoire → Plus d'options**,
choisir Chauffe-eau et saisir le code HomeKit de l'instance Homebridge qui le publie
(celui du child bridge si vous utilisez cette option).
L'accessoire TV doit être appairé séparément du pont principal.

Le UUID est stable selon `host` et `enumId`, pas selon le nom ou les libellés.
Préférer une IP réservée ou un nom local stable : changer host/enumId crée une
nouvelle identité HomeKit et nécessite un nouvel appairage.

| Paramètre | Défaut | Signification |
|---|---|---|
| name | Chauffe-eau | Nom de l'accessoire |
| host | obligatoire | IP ou nom local; port facultatif, sans URL |
| enumId | 200 | ID Enum, 200 à 299 |
| switchId | 0 | ID du relais à lire |
| pollInterval | 10 | Polling permanent de secours, en secondes |
| rpcTimeout | 5 | Timeout par appel RPC, en secondes |
| states.arret / auto / force | Arrêt / Auto / Marche forcée | Noms des sources |

Les noms sont limités à 64 octets UTF-8. Éviter de longs timeouts : Maison possède
aussi son propre délai de réponse, indépendamment du timeout Shelly.

## Synchronisation et erreurs

Au démarrage : aucune écriture. Lecture de l'Enum et du relais, puis mise à jour
atomique du mode et de l'indicateur. Avant cette lecture, aucune valeur supposée
n'est exposée comme valide.

Le canal WebSocket `/rpc` sert aux RPC et aux notifications `NotifyStatus`,
`NotifyFullStatus` et `NotifyEvent`. Une requête avec `src` inscrit le client pour
les notifications. Toute notification pertinente déclenche une relecture des
deux composants : les notifications partielles ou retardées ne sont pas utilisées
comme un état complet.

Le polling reste actif même si le WebSocket fonctionne, pour récupérer une
notification perdue et détecter une connexion silencieusement coupée. Sans
WebSocket, les lectures et commandes utilisent le RPC HTTP. Reconnexion avec
attente progressive de 1 à 30 secondes, puis relecture complète.

Une perte détectée invalide l'état et bloque les commandes tant qu'une lecture
complète n'a pas réussi. Un WebSocket coupé n'interdit pas le fonctionnement
HTTP après resynchronisation. Aucun changement n'est mis en file pour un appareil
hors ligne. Une écriture dont la réponse s'est perdue n'est **jamais rejouée** :
le plugin relit l'état, car la commande peut déjà avoir été exécutée.

Les valeurs Enum inconnues, réponses invalides, erreurs RPC et timeouts sont
signalés; Maison obtient une erreur de communication plutôt qu'un faux OFF.
Les lectures sont regroupées et les commandes sérialisées. Les logs de mode/
relais ne sont émis que si la valeur change, en dehors des connexions/erreurs.

## Validation

```sh
npm test
```

Le serveur Shelly simulé utilise de vrais RPC HTTP/WebSocket et les tests utilisent
les classes HAP-NodeJS chargées par Homebridge. Les fixtures de test simulent la
logique Shelly, **jamais le plugin**. Elles couvrent les dix scénarios demandés,
le refus HAP d'écriture du Switch, les états contradictoires mode/relais,
les notifications partielles, le polling, les redémarrages et les erreurs.

À vérifier également sur l'installation réelle :

1. Arrêt → Enum arret, relais OFF.
2. Auto en HP → Enum auto, relais OFF.
3. Auto en HC → Enum auto, relais ON.
4. Marche forcée → Enum force, relais ON.
5. Le script Shelly fait force → auto en HC, relais reste ON.
6. Changer le mode dans l'UI Shelly → source active mise à jour dans Maison.
7. Choisir une source dans Maison → Enum mis à jour dans Shelly.
8. Modifier le relais depuis Shelly → indicateur ON/OFF mis à jour.
9. Redémarrer Homebridge → état réel restauré, sans écriture.
10. Déconnecter/reconnecter le Shelly → indisponibilité puis resynchronisation.
11. Toucher l'indicateur → aucune écriture Enum ou relais, même si Maison montre une erreur.

## Références

- [API Enum officielle : GetStatus et Set](https://shelly-api-docs.shelly.cloud/gen2/DynamicComponents/Virtual/Enum/)
- [Canaux RPC Shelly](https://shelly-api-docs.shelly.cloud/gen2/General/RPCChannels/)
- [Exemple TV HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS/blob/latest/src/accessories/TV_accessory.ts)
- [Limite de Maison : Switch read-only](https://github.com/homebridge/HAP-NodeJS/issues/637)
- [Noms de sources et tvOS](https://github.com/homebridge/homebridge/issues/3703)

## Licence

MIT.

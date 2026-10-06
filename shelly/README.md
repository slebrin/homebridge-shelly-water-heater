# Script du Shelly et contacteur

Le [script fourni](./water-heater.js) est celui partagé par le propriétaire de
l'installation, avec autorisation de redistribution sous la [licence MIT](../LICENSE).
Seule sa mise en forme a été restaurée à partir du texte partagé; sa logique
n'a pas été modifiée.

Il s'exécute **sur le Shelly**, pas dans Homebridge ni dans Node.js. Ses appels
`Switch.Set` sont donc normaux : le Shelly commande le relais, tandis que le
plugin Homebridge se limite à sélectionner le mode et lire l'état.

## Périmètre et compatibilité

- Matériel déclaré : Shelly 1 Gen4.
- Version de référence : script initial fourni avec le projet 1.0.0.
- Version exacte du firmware : non communiquée, à renseigner après validation.
- Le script a été communiqué comme celui installé sur le Shelly; son exécution
  et le câblage n'ont pas été vérifiés sur le matériel par les tests du plugin.
- Les tests du plugin utilisent une simulation de l'API Shelly, pas ce script.

## Composants attendus

| Composant | Utilisation |
|---|---|
| `enum:200` | Valeurs exactes `auto`, `force`, `arret` |
| `input:0` | Entrée indiquant HP/HC : `state === true` signifie HC |
| `switch:0` | Relais piloté par le script |

Les IDs sont codés en dur dans le script. Modifier `enumId` ou `switchId` dans
Homebridge ne modifie pas ce script. La polarité de l'entrée doit correspondre
à la convention ci-dessus; elle doit être vérifiée sur l'installation réelle.
L'entrée doit permettre de lire un état booléen stable. La commande du relais
par cette entrée doit être dissociée de toute commande automatique concurrente
du firmware, pour que le script reste responsable de sa décision.

## Fonctionnement

| Mode | Entrée HC | Relais demandé |
|---|---|---|
| `arret` | false ou true | OFF |
| `auto` | false (HP) | OFF |
| `auto` | true (HC) | ON |
| `force` | false ou true | ON |

Le script écoute les changements du mode et de `input:0`. Au passage observé
de `false` à `true`, si le mode est `force`, il sélectionne `auto`. Le changement
de l'Enum déclenche ensuite la mise à jour du relais.

Au démarrage, il mémorise l'entrée et applique le mode courant. **Démarrer en HC
n'est pas un passage HP → HC** : un mode `force` déjà présent n'est pas converti
automatiquement en `auto` au seul démarrage du script.

## Installation manuelle

Si le script fonctionne déjà dans votre installation, **ne pas le réinstaller**
uniquement pour ajouter le plugin.

Pour une nouvelle installation, après validation matérielle :

1. Sauvegarder les scripts et paramètres existants du Shelly.
2. Vérifier que `enum:200` existe avec les trois valeurs exactes attendues.
   Le script et le plugin ne créent pas ce composant.
3. Vérifier la configuration et la polarité de `input:0`, ainsi que l'absence
   de scripts, horaires ou commandes automatiques concurrents sur `switch:0`.
4. Dans l'interface locale Shelly, créer un script et y copier
   [water-heater.js](./water-heater.js). Ne pas le lancer dans Node.js.
5. Enregistrer, activer le démarrage automatique du script si souhaité, puis
   le démarrer en tenant compte du fait qu'il applique immédiatement le mode.
6. Vérifier les journaux, les valeurs des composants et le comportement réel.
   La persistance du mode et le mode de démarrage du relais dépendent également
   des paramètres Shelly; les configurer explicitement selon votre installation.
7. Configurer ensuite le plugin Homebridge selon le [guide principal](../README.md).

Le plugin n'installe, ne démarre et ne modifie jamais ce script.

## Limites du script fourni

Ces points décrivent le code actuel, sans le corriger :

- Si l'Enum est absent, le script lève une erreur.
- Si la lecture de l'entrée échoue, il journalise une erreur et ne change pas
  le relais : celui-ci conserve son état précédent.
- Une valeur de mode inconnue conduit à demander OFF lorsque l'entrée est lisible.
- Le résultat de `Switch.Set` n'est pas vérifié par un callback. Le journal
  ON/OFF décrit la **commande demandée**, pas la confirmation du relais.
  Le plugin, lui, lit la valeur `output` réellement exposée par Shelly.
- Le gestionnaire de statut traite tout delta de `input:0` comme si `state` était
  présent : un delta sans `state` est interprété comme false. Ce comportement
  doit être pris en compte lors de la validation des notifications du firmware.
- Si le script s'arrête, Homebridge ne remplace pas sa logique.

## Validation sur le Shelly

Vérifier Arrêt, Auto en HP, Auto en HC et Force, puis un véritable passage
HP → HC depuis Force : le mode doit devenir Auto et le relais rester ON.
Vérifier également le redémarrage du Shelly, les paramètres de persistance,
le lancement automatique du script et la reprise de l'entrée.

## Documentation du contacteur : informations encore nécessaires

Ce projet ne contient pas encore de schéma de câblage validé. Pour documenter
l'installation exacte, il faut les références du contacteur et du chauffe-eau,
la tension de commande de la bobine, les notices officielles et le schéma existant.

Le relais du Shelly est ici décrit comme commandant le contacteur, et non comme
alimentant directement la résistance du chauffe-eau. Le code ne valide ni le
dimensionnement électrique, ni les protections, ni le câblage.

Ne pas intervenir sur le secteur à partir de cette documentation logicielle.
Le câblage doit respecter les notices du matériel et être réalisé ou vérifié
par un professionnel qualifié.

Références officielles :

- [Shelly 1 Gen4 : fiche et documentation](https://kb.shelly.cloud/knowledge-base/shelly-1-gen4)
- [API des composants virtuels](https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/Virtual/)
- [API Enum](https://shelly-api-docs.shelly.cloud/gen2/DynamicComponents/Virtual/Enum/)

# Changelog

## 1.1.1 - 2026-10-07

- Le Switch annonce la permission d'écriture requise par Apple Maison pour
  apparaître comme une tuile dans la vue Pièce.
- Toute commande sur cette tuile reste systématiquement refusée avec
  `READ_ONLY_CHARACTERISTIC`.
- Aucun `Switch.Set` n'est envoyé au Shelly.

## 1.1.0 - 2026-10-07

- Le bouton principal Television sélectionne Arrêt lorsqu'il passe à OFF.
- Rallumer depuis Arrêt sélectionne Auto.
- Le bouton reste ON en modes Auto et Marche forcée.
- La liste des sources contient désormais uniquement Auto et Marche forcée.
- Les identifiants historiques 2 et 3 sont conservés pour ces deux sources.
- Le Switch de chauffe devient un accessoire HomeKit autonome, favorisable
  indépendamment de la Television.
- Le Switch reste un indicateur strictement en lecture seule de `switch:0`.
- La séparation évite le résumé natif « Toutes activées » des services regroupés.

## 1.0.0 - 2026-10-06

- Première version publique.

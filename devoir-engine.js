/* ==========================================================================
   devoir-engine.js — Moteur de devoirs/examens interactifs
   ==========================================================================
   API en "chaîne fluide" : on appelle Devoir.creer({...}).exercice(...).
   La bibliothèque s'occupe du rendu DOM, de la sauvegarde locale, de la
   progression et du mode correction par l'adulte.

   USAGE TYPIQUE :

     <link rel="stylesheet" href="devoir-engine.css">
     <script src="devoir-engine.js"><\/script>
     <body class="de-body"><div id="app"></div></body>
     <script>
       const d = Devoir.creer({
         cible: '#app',
         eleve: 'Amélia',
         type: 'examen',
         matiere: "Français, langue d'enseignement",
         sujet: 'Examen — 2e trimestre',
         niveau: '2e année',
         cycle: '1er cycle du primaire',
         difficulte: 'Difficile',
         objectif: 'Lire un récit, écrire des phrases...',
         total: 50,
         storageKey: 'examen_amelia_fr_t2'
       });

       d.exercice(1, 'Je lis et je comprends', 6)
         .consigne('Lis attentivement...')
         .histoire("C'est samedi matin...")
         .texte('Quel jour ?', 'ex1a')
         .texte('Avec qui ?', 'ex1b');

       d.bonus('Trouve 3 mots...', '+2 pts',
               ['bonus1','bonus2','bonus3']);

       d.signoff('Bravo Amélia !');
       d.render();
     <\/script>

   ARCHITECTURE :
   - Devoir.creer(opts) -> retourne un objet `Devoir` avec une API chaînable
   - Les exercices accumulent des "blocs" (composants) dans une liste
   - .render() instancie le DOM
   - Tous les composants se sauvegardent en localStorage automatiquement
   - Le mode correction est un toggle global qui montre les inputs de score
     par exercice et recalcule le total

   ÉVOLUTIVITÉ :
   - Chaque composant est défini par une fonction qui prend (state, exData,
     ...args) et renvoie un élément DOM. Pour ajouter un nouveau type
     d'exercice (ex. plan cartésien, balance équilibrée), on ajoute une
     méthode au prototype Exercice qui pousse un bloc avec un constructeur
     de DOM dédié. Voir COMPOSANTS plus bas pour la liste.
   ========================================================================== */

(function(global) {
  'use strict';

  // ========================================================================
  // UTILS DOM
  // ========================================================================
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class')      el.className = attrs[k];
        else if (k === 'html')  el.innerHTML = attrs[k];
        else if (k === 'text')  el.textContent = attrs[k];
        else if (k === 'style' && typeof attrs[k] === 'object') {
          Object.assign(el.style, attrs[k]);
        }
        else if (k.startsWith('on') && typeof attrs[k] === 'function') {
          el.addEventListener(k.substring(2).toLowerCase(), attrs[k]);
        }
        else if (k.startsWith('data-')) el.setAttribute(k, attrs[k]);
        else if (attrs[k] != null) el.setAttribute(k, attrs[k]);
      }
    }
    if (children != null) {
      const arr = Array.isArray(children) ? children : [children];
      arr.forEach(c => {
        if (c == null || c === false) return;
        if (typeof c === 'string') el.appendChild(document.createTextNode(c));
        else el.appendChild(c);
      });
    }
    return el;
  }

  // ========================================================================
  // STORAGE
  // ========================================================================
  function createStore(key) {
    let state = {};
    try { state = JSON.parse(localStorage.getItem(key) || '{}'); }
    catch (e) { state = {}; }

    return {
      get(k, def) { return state[k] != null ? state[k] : def; },
      set(k, v)   { state[k] = v; save(); },
      del(k)      { delete state[k]; save(); },
      all()       { return state; },
      reset()     { state = {}; try { localStorage.removeItem(key); } catch (e) {} }
    };
    function save() {
      try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) {}
    }
  }

  // ========================================================================
  // EXERCICE — accumule des blocs, sait se rendre
  // ========================================================================
  function Exercice(devoir, num, titre, points) {
    this.devoir  = devoir;
    this.num     = num;
    this.titre   = titre;
    this.points  = points;
    this.blocs   = []; // chaque bloc = { type, ...data, build(store, ex, devoir) -> Element }
  }

  // -- Blocs de contenu textuel ---------------------------------------------
  Exercice.prototype.consigne = function(texte) {
    this.blocs.push({ type:'consigne', texte });
    return this;
  };
  Exercice.prototype.rappel = function(html) {
    this.blocs.push({ type:'rappel', html });
    return this;
  };
  Exercice.prototype.histoire = function(paragraphes) {
    // paragraphes : string ou array de strings
    const arr = Array.isArray(paragraphes) ? paragraphes : [paragraphes];
    this.blocs.push({ type:'histoire', paragraphes: arr });
    return this;
  };
  Exercice.prototype.intro = function(html) {
    this.blocs.push({ type:'intro', html });
    return this;
  };

  // -- Blocs de question ----------------------------------------------------
  // 1) Réponse en texte libre (ligne)
  // Args: (label, key) ou (label, key, {placeholder, lignes})
  Exercice.prototype.texte = function(label, key, opts) {
    opts = opts || {};
    this.blocs.push({ type:'texte', label, key,
      placeholder: opts.placeholder || '',
      lignes: opts.lignes || 1 });
    return this;
  };

  // 2) Textarea (rédaction libre)
  Exercice.prototype.redaction = function(label, key, opts) {
    opts = opts || {};
    this.blocs.push({ type:'redaction', label, key,
      placeholder: opts.placeholder || '',
      hauteur: opts.hauteur || 140 });
    return this;
  };

  // 3) Phrase à compléter avec un blanc à la fin (ou plusieurs blancs)
  // Exemple : phraseATrous("Je ___ contente", ["ex1a"])
  //           phraseATrous("Mon ___ est ___", ["k1", "k2"])
  Exercice.prototype.phraseATrous = function(modele, keys, opts) {
    opts = opts || {};
    this.blocs.push({ type:'phraseATrous', modele, keys,
      width: opts.width || '100px' });
    return this;
  };

  // 4) Champ-réponse rapide après un label inline (ex: "un ami → _____")
  // Le label peut contenir des balises HTML simples.
  Exercice.prototype.ligneAvecFleche = function(html, key, opts) {
    opts = opts || {};
    this.blocs.push({ type:'ligneAvecFleche', html, key,
      width: opts.width || '60%' });
    return this;
  };

  // -- Blocs d'interaction --------------------------------------------------
  // 5) Choix multiple inline (boutons pastilles)
  // Args: (avantLabel, key, choix, apresLabel)
  // Si on veut juste un choix sans phrase autour, mettre avant et après vide.
  Exercice.prototype.choixInline = function(avant, key, choix, apres) {
    this.blocs.push({ type:'choixInline', avant, key, choix, apres });
    return this;
  };

  // 6) Vrai/Faux (un ou plusieurs énoncés en grappe)
  // Args: [{label, key}, {label, key}, ...]
  Exercice.prototype.vraiFaux = function(items) {
    this.blocs.push({ type:'vraiFaux', items });
    return this;
  };

  // 7) Grille S/P ou autres labels binaires
  // Args: items: [{label, key}], options: ['S','P']
  Exercice.prototype.toggleGrille = function(items, options, opts) {
    opts = opts || {};
    this.blocs.push({ type:'toggleGrille', items, options,
      colonnes: opts.colonnes || 2 });
    return this;
  };

  // 8) Mots cliquables (intrus)
  // Args: (lblPrefix, mots, key) — mots = liste, key = clé de sauvegarde
  Exercice.prototype.motsIntrus = function(lblPrefix, mots, key) {
    this.blocs.push({ type:'motsIntrus', lblPrefix, mots, key });
    return this;
  };

  // 9) Paires à relier (deux colonnes)
  // Args: gauche: [string], droite: [string], key: 'exN_pairs'
  // Note : on ne donne PAS la bonne réponse à l'élève. L'agent peut mettre
  // droite dans n'importe quel ordre (idéalement brouillé).
  Exercice.prototype.paires = function(gauche, droite, key) {
    this.blocs.push({ type:'paires', gauche, droite, key });
    return this;
  };

  // 10) Mots-chips à classer / sélectionner (généraliste)
  // mode: 'select' (un seul), 'multi' (plusieurs)
  Exercice.prototype.motsChips = function(lblPrefix, mots, key, mode) {
    this.blocs.push({ type:'motsChips', lblPrefix, mots, key,
      mode: mode || 'select' });
    return this;
  };

  // -- Composants mathématiques (extension future) --------------------------
  // 11) Fraction à colorier (barre rectangulaire)
  // Args: (label, parts, key, opts) — l'enfant clique pour colorier
  Exercice.prototype.fractionAColorier = function(label, parts, key, opts) {
    opts = opts || {};
    this.blocs.push({ type:'fractionAColorier', label, parts, key,
      consigne: opts.consigne || '' });
    return this;
  };

  // 12) Fraction donnée (affichage seul, déjà coloriée)
  Exercice.prototype.fractionDonnee = function(label, num, den) {
    this.blocs.push({ type:'fractionDonnee', label, num, den });
    return this;
  };

  // 13) SVG libre — pour figures géométriques, plans, schémas
  // L'agent fournit le SVG en string. Affichage centré dans un wrapper.
  Exercice.prototype.svg = function(svgContent, opts) {
    opts = opts || {};
    this.blocs.push({ type:'svg', svgContent,
      caption: opts.caption || '' });
    return this;
  };

  // 14) HORLOGES — une ou plusieurs horloges analogiques, aiguilles placées
  // Usage : .horloges([{heure: 9, minutes: 30, label: 'a)'}, ...])
  // Le builder calcule les angles et dessine le cadran + aiguilles.
  // Options : { taille: 'sm'|'md'|'lg', graduationsMinutes: bool }
  //
  // ⚠️ Important — le champ `label` est rendu dans un <text> SVG : il accepte
  //    UNIQUEMENT du TEXTE BRUT. Aucune balise HTML (`<b>`, `<i>`, `<sup>`,
  //    `<span>`…) n'est interprétée — elles s'afficheraient littéralement
  //    (échappées en `&lt;b&gt;`). Pour mettre en évidence, utilise des
  //    MAJUSCULES, des guillemets ou une numérotation courte (« a) », « 1ère »).
  //    Garde le label COURT (≤ 25 caractères) car l'espace sous l'horloge
  //    est limité.
  //    Exemples valides :  'a) Début'  /  'Fin 1re période'  /  'Match'
  //    Exemples invalides : '<b>19h00</b>'  /  '1<sup>re</sup> période'
  Exercice.prototype.horloges = function(horloges, opts) {
    opts = opts || {};
    this.blocs.push({ type:'horloges',
      horloges: horloges,
      taille: opts.taille || 'md',
      graduationsMinutes: !!opts.graduationsMinutes
    });
    return this;
  };

  // 15) DIAGRAMME À BANDES — graphique simple avec axe et étiquettes
  // Usage : .diagrammeBandes({
  //   titre: 'Livres lus en mai',
  //   axeY: 'Nombre de livres',
  //   donnees: [{categorie: 'Léa', valeur: 6}, ...],
  //   max: 10,   // optionnel, sinon auto
  //   pas: 2     // graduation
  // })
  Exercice.prototype.diagrammeBandes = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'diagrammeBandes',
      titre: opts.titre || '',
      axeY: opts.axeY || '',
      axeX: opts.axeX || '',
      donnees: opts.donnees || [],
      max: opts.max || null,
      pas: opts.pas || null
    });
    return this;
  };

  // 16) THERMOMÈTRES — un ou plusieurs thermomètres à lire avec champ réponse
  // Usage : .thermometres([
  //   { temperature: -19, label: 'A', key: 't_a' },
  //   { temperature: 25,  label: 'B', key: 't_b' }
  // ], { min: -25, max: 25, graduation: 5 })
  // Le builder dessine le tube en SVG avec la colonne remplie à la bonne hauteur,
  // suivi d'un champ texte pour que l'enfant écrive la lecture.
  Exercice.prototype.thermometres = function(items, opts) {
    opts = opts || {};
    this.blocs.push({ type:'thermometres',
      items: items || [],
      min: (opts.min != null) ? opts.min : -25,
      max: (opts.max != null) ? opts.max : 25,
      graduation: opts.graduation || 5
    });
    return this;
  };

  // 17) PLAN CARTÉSIEN — grille quadrillée avec axes étiquetés
  // Usage : .planCartesien({
  //   maxX: 10, maxY: 10,           // bornes du plan
  //   points: [                      // points déjà placés (montrés à l'enfant)
  //     { x: 2, y: 5, label: 'A' },
  //     { x: 7, y: 3, label: 'B' }
  //   ],
  //   aPlacer: ['C(4, 6)', 'D(8, 2)']  // points à placer (juste affichés en consigne)
  // })
  // Si aucun point n'est fourni, c'est une grille vide à compléter à la main.
  Exercice.prototype.planCartesien = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'planCartesien',
      maxX: opts.maxX || 10,
      maxY: opts.maxY || 10,
      points: opts.points || [],
      aPlacer: opts.aPlacer || [],
      titre: opts.titre || ''
    });
    return this;
  };

  // 17 bis) GRILLE DE DESSIN INTERACTIVE — l'enfant trace des polygones
  //         (carrés, rectangles, parallélogrammes, etc.) directement sur
  //         une grille quadrillée. Les sommets s'accrochent aux intersections
  //         de la grille, et chaque segment est forcé à un angle de 0°, 45°
  //         ou 90° (horizontal, vertical ou diagonal) par rapport au sommet
  //         précédent. Idéal pour les situations-problèmes de géométrie où
  //         l'enfant doit dessiner un plan respectant des contraintes
  //         d'aire et de périmètre.
  // Usage : .grilleDessin({
  //   cols: 20, rows: 14,           // dimensions de la grille (carrés-unités)
  //   enclos: [                     // un "calque" par enclos à dessiner
  //     { id: 'lion',     nom: '🦁 Lion',     couleur: '#f4a261' },
  //     { id: 'elephant', nom: '🐘 Éléphant', couleur: '#a8a8b8' },
  //     { id: 'girafe',   nom: '🦒 Girafe',   couleur: '#e9c46a' }
  //   ],
  //   key: 'plan_parc',             // clé unique pour la persistance
  //   titre: '...',                 // titre affiché au-dessus de la grille
  //   consigne: '...',              // petite consigne sous le titre
  //   cellPx: 30                    // taille d'un carré-unité en pixels (défaut 30)
  // })
  // L'enfant sélectionne un enclos dans la barre d'outils, puis touche des
  // points sur la grille pour tracer son polygone. Pour fermer un polygone,
  // toucher le premier sommet du polygone en cours.
  Exercice.prototype.grilleDessin = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'grilleDessin',
      cols: opts.cols || 20,
      rows: opts.rows || 14,
      enclos: opts.enclos || [],
      key: opts.key,
      titre: opts.titre || '',
      consigne: opts.consigne || '',
      cellPx: opts.cellPx || 30,
      label: opts.label || ''
    });
    return this;
  };

  // 18) GRILLE D'AIRES — figures dans une grille quadrillée pour compter
  //     les carrés-unités. Les figures sont des polygones définis par des
  //     coordonnées en unités de la grille.
  // Usage : .grilleAires({
  //   cols: 10, rows: 6,
  //   figures: [
  //     { num: 1, cellules: [[0,0],[1,0],[2,0],[0,1],[1,1]] },  // tetris-shape
  //     { num: 2, cellules: [[4,0],[5,0],[6,0],[7,0],[5,1],[6,1]] }
  //   ]
  // })
  // Chaque figure colore les cellules listées (case par case).
  Exercice.prototype.grilleAires = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'grilleAires',
      cols: opts.cols || 10,
      rows: opts.rows || 6,
      figures: opts.figures || []
    });
    return this;
  };

  // 19) OPÉRATION EN COLONNE — addition/soustraction posée avec un champ
  //     de saisie pour chaque chiffre du résultat.
  // Usage : .operationColonne({
  //   operande1: '180,8',
  //   operande2: '124,56',
  //   operateur: '+',           // '+', '−', '×', '÷'
  //   key: 'op_a',
  //   nbChiffresResultat: 6     // optionnel, sinon auto
  // })
  Exercice.prototype.operationColonne = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'operationColonne',
      operande1: String(opts.operande1 || ''),
      operande2: String(opts.operande2 || ''),
      operateur: opts.operateur || '+',
      key: opts.key || ('op_' + Math.random().toString(36).slice(2,8)),
      label: opts.label || ''
    });
    return this;
  };

  // 20) FRACTION CERCLE — disque divisé en parts égales, à colorier.
  // Usage : .fractionCercle(label, parts, key, { consigne, taille })
  Exercice.prototype.fractionCercle = function(label, parts, key, opts) {
    opts = opts || {};
    this.blocs.push({ type:'fractionCercle', label, parts, key,
      consigne: opts.consigne || '',
      taille:   opts.taille   || 'md'
    });
    return this;
  };

  // 21) DÉCOMPOSITION ADDITIVE — décomposer un nombre selon la valeur de
  //     position, en style équation : 4 275 = [ ] + [ ] + [ ] + [ ]
  //                                            UM    C     D    U
  //     L'enfant écrit la VALEUR de chaque chiffre (4000, 200, 70, 5).
  // Usage : .decomposition({
  //   nombre:    4275,
  //   positions: ['UM','C','D','U'],         // libellé affiché sous chaque case
  //   keys:      ['k_um','k_c','k_d','k_u'], // une clé par case
  //   label:     'a) 4 275 →'                // (optionnel) ligne au-dessus
  // })
  // Pour les décimaux, mettre les positions décimales en minuscules :
  // ['U','d','c'] pour unités, dixièmes, centièmes.
  Exercice.prototype.decomposition = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'decomposition',
      nombre:    opts.nombre,
      positions: opts.positions || ['C','D','U'],
      keys:      opts.keys      || [],
      label:     opts.label     || ''
    });
    return this;
  };

  // 22) LIGNE NUMÉRIQUE — droite graduée horizontale.
  // Usage : .ligneNumerique({ min, max, pas, pasMineur, marques, etiquettes })
  //   marques : [{ valeur, label? }, { valeur, key? }, ...]
  Exercice.prototype.ligneNumerique = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'ligneNumerique',
      min:        (opts.min  != null) ? opts.min  : 0,
      max:        (opts.max  != null) ? opts.max  : 100,
      pas:        opts.pas        || 10,
      pasMineur:  opts.pasMineur  || null,
      marques:    opts.marques    || [],
      etiquettes: opts.etiquettes || 'extremes',
      label:      opts.label      || ''
    });
    return this;
  };

  // 23) GLISSER-DÉPOSER PAR CATÉGORIES — tri d'étiquettes en 2 ou 3 colonnes.
  // Modèle tap-to-place (compatible tablette).
  // Usage : .glisserDeposerCategories({ items, categories, key, consigne })
  Exercice.prototype.glisserDeposerCategories = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'glisserDeposerCategories',
      items:      opts.items      || [],
      categories: opts.categories || [],
      key:        opts.key        || ('tri_' + Math.random().toString(36).slice(2,8)),
      consigne:   opts.consigne   || ''
    });
    return this;
  };


  // 24) FRACTION COLLECTION — grille de pastilles colorées (« combien de
  //     billes sont rouges sur 8 ? »). Affichage seul d'une collection,
  //     l'enfant écrit la fraction dans 2 cases (num/den).
  Exercice.prototype.fractionCollection = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'fractionCollection',
      items:   opts.items   || [],
      key:     opts.key     || ('fc_' + Math.random().toString(36).slice(2,8)),
      formes:  opts.formes  || 'cercles',
      couleur: opts.couleur || 'accent',
      label:   opts.label   || '',
      consigne: opts.consigne || ''
    });
    return this;
  };

  // 25) SYMÉTRIE — affiche une figure géométrique, plusieurs axes
  //     candidats traversent la figure ; l'enfant clique les bons.
  Exercice.prototype.symetrie = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'symetrie',
      figure: opts.figure || 'rectangle',
      axes:   opts.axes   || [],
      key:    opts.key    || ('sym_' + Math.random().toString(36).slice(2,8)),
      mode:   opts.mode   || 'multi',
      label:  opts.label  || '',
      consigne: opts.consigne || ''
    });
    return this;
  };

  // 26) DIAGRAMME À PICTOGRAMMES — chaque catégorie représentée par un
  //     nombre d'icônes. Composant purement visuel.
  Exercice.prototype.diagrammePictogrammes = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'diagrammePictogrammes',
      titre:          opts.titre          || '',
      donnees:        opts.donnees        || [],
      symbole:        opts.symbole        || '\u2605',
      valeurUnitaire: opts.valeurUnitaire || 1,
      legende:        opts.legende        || ''
    });
    return this;
  };

  // 27) DIAGRAMME À LIGNE BRISÉE — courbe joignant des points dans un
  //     repère (températures, croissance, ventes…).
  Exercice.prototype.diagrammeLigneBrisee = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'diagrammeLigneBrisee',
      titre:   opts.titre   || '',
      axeX:    opts.axeX    || '',
      axeY:    opts.axeY    || '',
      donnees: opts.donnees || [],
      min:     (opts.min != null) ? opts.min : null,
      max:     (opts.max != null) ? opts.max : null,
      pas:     opts.pas     || null
    });
    return this;
  };

  // 28) NOMBRE MIXTE — saisie d'un nombre fractionnaire (entier + num/den) ou
  //     d'une simple fraction (sans entier). Trois cases distinctes guident
  //     la forme attendue : utile pour 5e année (fraction impropre ↔ mixte).
  // Usage : .nombreMixte('a) 9/4 →', 'k_a')                       // entier + num/den (3 cases)
  //         .nombreMixte('b) Réponse :', 'k_b', { entier: false }) // seulement num/den
  Exercice.prototype.nombreMixte = function(label, key, opts) {
    opts = opts || {};
    this.blocs.push({ type:'nombreMixte',
      label:  label || '',
      key:    key,
      entier: (opts.entier !== false),       // true par défaut
      consigne: opts.consigne || ''
    });
    return this;
  };

  // 29) ARGENT QUÉBÉCOIS — affiche un assortiment de pièces et billets
  //     canadiens et propose un champ pour écrire le total (en dollars ou
  //     en cents selon la consigne donnée par l'agent).
  // Types acceptés : '1c', '5c', '10c', '25c', '1$', '2$', '5$', '10$', '20$'.
  // Usage : .argentQc('a) Quel est le total ?', [
  //           { type: '1$',  qte: 2 },
  //           { type: '25c', qte: 3 },
  //           { type: '10c', qte: 1 }
  //         ], 'k_arg_a', { uniteResultat: '$' })
  Exercice.prototype.argentQc = function(label, pieces, key, opts) {
    opts = opts || {};
    this.blocs.push({ type:'argentQc',
      label:         label || '',
      pieces:        pieces || [],
      key:           key,
      uniteResultat: opts.uniteResultat || '$',  // '$' ou '¢'
      consigne:      opts.consigne || ''
    });
    return this;
  };

  // 30) CALENDRIER — affiche un mois (grille 7 colonnes lun..dim) avec des
  //     dates pouvant être pré-marquées ; l'enfant peut sélectionner une date
  //     (mode 'select') ou seulement lire (mode 'lecture').
  // Usage : .calendrier({
  //   mois: 3,                // 1..12 (3 = mars)
  //   annee: 2026,
  //   marquer: [14, 21],      // jours pré-encadrés (ex. l'anniversaire)
  //   key: 'k_cal_a',         // requis en mode 'select'
  //   mode: 'select',         // 'select' (défaut) ou 'lecture'
  //   debutSemaine: 'lundi'   // 'lundi' (défaut) ou 'dimanche'
  // })
  Exercice.prototype.calendrier = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'calendrier',
      mois:         (opts.mois  != null) ? opts.mois  : 1,
      annee:        (opts.annee != null) ? opts.annee : 2026,
      marquer:      opts.marquer || [],
      key:          opts.key     || null,
      mode:         opts.mode    || 'select',
      debutSemaine: opts.debutSemaine || 'lundi',
      label:        opts.label   || '',
      consigne:     opts.consigne || ''
    });
    return this;
  };

  // 31) LIGNE DU TEMPS — axe horizontal gradué avec événements pré-placés
  //     et/ou liste d'événements à ordonner. En mode 'ordre', l'enfant écrit
  //     l'ordre chronologique (1, 2, 3...) dans une case devant chaque
  //     événement listé sous la frise.
  // Usage (lecture seule, histoire) :
  //   .ligneTemps({ debut: 1500, fin: 2000, pas: 100,
  //                 evenements: [
  //                   { date: 1534, label: 'Jacques Cartier' },
  //                   { date: 1608, label: 'Fondation de Québec' }
  //                 ] })
  // Usage (mettre en ordre) :
  //   .ligneTemps({ debut: 1500, fin: 2000, pas: 100,
  //                 aOrdonner: [
  //                   { label: 'Confédération canadienne' },
  //                   { label: 'Fondation de Montréal' },
  //                   { label: 'Conquête britannique' }
  //                 ],
  //                 key: 'k_lt_a' })
  Exercice.prototype.ligneTemps = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'ligneTemps',
      debut:       (opts.debut != null) ? opts.debut : 0,
      fin:         (opts.fin   != null) ? opts.fin   : 100,
      pas:         opts.pas        || null,
      evenements:  opts.evenements || [],
      aOrdonner:   opts.aOrdonner  || [],
      key:         opts.key        || null,
      label:       opts.label      || '',
      consigne:    opts.consigne   || ''
    });
    return this;
  };

  // 32) SCHÉMA ANNOTÉ — image (SVG donnée par l'agent) avec des points
  //     d'étiquetage où l'enfant doit écrire le nom de la partie indiquée.
  //     Chaque point est positionné en pourcentage du viewBox (0..100).
  // Usage : .schemaAnnote({
  //   svg: '<svg viewBox="0 0 300 200">...</svg>',
  //   points: [
  //     { x: 50, y: 20, label: '1', key: 'k_a_1' },
  //     { x: 78, y: 55, label: '2', key: 'k_a_2' }
  //   ],
  //   hauteur: 220   // hauteur d'affichage en px (optionnel)
  // })
  Exercice.prototype.schemaAnnote = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'schemaAnnote',
      svg:      opts.svg     || '',
      points:   opts.points  || [],
      hauteur:  opts.hauteur || 240,
      label:    opts.label   || '',
      consigne: opts.consigne || ''
    });
    return this;
  };

  // 33) CYCLE DE VIE / CYCLE NATUREL — diagramme circulaire d'étapes
  //     ordonnées avec flèches. Mode 'lecture' : étapes affichées dans
  //     l'ordre. Mode 'ordre' : étapes étiquetées de lettres A, B, C…
  //     dans un ordre brouillé et l'enfant écrit l'ordre chronologique
  //     (1 = première étape) sous chacune.
  // Usage (lecture) :
  //   .cycleVie({ etapes: [
  //     { label: 'Œuf' }, { label: 'Chenille' },
  //     { label: 'Chrysalide' }, { label: 'Papillon' }
  //   ] })
  // Usage (mise en ordre) :
  //   .cycleVie({ etapes: [
  //     { label: 'Chenille' }, { label: 'Papillon' },
  //     { label: 'Œuf' },      { label: 'Chrysalide' }
  //   ], mode: 'ordre', key: 'k_cyc_a' })
  Exercice.prototype.cycleVie = function(opts) {
    opts = opts || {};
    this.blocs.push({ type:'cycleVie',
      etapes:   opts.etapes  || [],
      mode:     opts.mode    || 'lecture',     // 'lecture' ou 'ordre'
      key:      opts.key     || null,
      label:    opts.label   || '',
      consigne: opts.consigne || ''
    });
    return this;
  };

  // -- Espacement -----------------------------------------------------------
  Exercice.prototype.espace = function(px) {
    this.blocs.push({ type:'espace', px: px || 16 });
    return this;
  };

  // -- Retour au devoir parent (pour chaîner sur le devoir) -----------------
  Exercice.prototype.fin = function() { return this.devoir; };
  // raccourci : permet de continuer en appelant .exercice(...) sur le Exercice
  Exercice.prototype.exercice = function(n, t, p) {
    return this.devoir.exercice(n, t, p);
  };
  Exercice.prototype.bonus = function() {
    return this.devoir.bonus.apply(this.devoir, arguments);
  };
  Exercice.prototype.signoff = function() {
    return this.devoir.signoff.apply(this.devoir, arguments);
  };

  // ========================================================================
  // RENDU DES BLOCS — un constructeur de DOM par type
  // ========================================================================
  const Composants = {

    consigne(b) {
      // Le texte de la consigne peut contenir du HTML inline (b, i, sup, sub,
      // span, em…). On utilise `html` (innerHTML) plutôt que de passer le
      // texte en 3e argument (qui le rendrait en textContent et afficherait
      // les balises littéralement). Les consignes en texte brut continuent
      // de fonctionner identiquement.
      return h('p', { class:'de-consigne', html: b.texte });
    },

    rappel(b) {
      return h('div', { class:'de-rappel', html: b.html });
    },

    histoire(b) {
      return h('div', { class:'de-story' },
        b.paragraphes.map(p => h('p', { text: p })));
    },

    intro(b) {
      return h('div', { class:'de-q', html: b.html });
    },

    texte(b, store) {
      const wrap = h('div', { class:'de-q' });
      if (b.label) {
        wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      }
      for (let i = 0; i < b.lignes; i++) {
        const k = b.lignes === 1 ? b.key : b.key + '_' + i;
        const inp = h('input', { type:'text',
          placeholder: b.placeholder,
          value: store.get(k, '') });
        inp.addEventListener('input', () => store.set(k, inp.value));
        wrap.appendChild(inp);
      }
      return wrap;
    },

    redaction(b, store) {
      const wrap = h('div', { class:'de-q' });
      if (b.label) wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      const ta = h('textarea', {
        placeholder: b.placeholder,
        style: { minHeight: b.hauteur + 'px' }
      });
      ta.value = store.get(b.key, '');
      ta.addEventListener('input', () => store.set(b.key, ta.value));
      wrap.appendChild(ta);
      return wrap;
    },

    phraseATrous(b, store) {
      // Remplace chaque '___' par un input. Découpage : split sur '___'.
      // On utilise innerHTML pour les segments de texte afin que les entités
      // (&nbsp;, &amp;, ...) et le HTML simple (<b>, <sup>, ...) soient interprétés.
      const parts = b.modele.split(/_{3,}/);
      const wrap = h('div', { class:'de-q' });
      const line = h('div', { class:'de-q-label', style:{lineHeight:'2.4'} });
      parts.forEach((part, i) => {
        if (part !== '') {
          const span = document.createElement('span');
          span.innerHTML = part;
          line.appendChild(span);
        }
        if (i < parts.length - 1) {
          const key = b.keys[i] || (b.keys[0] + '_' + i);
          const inp = h('input', {
            type:'text', class:'de-blank-inline',
            style:{ width: b.width },
            value: store.get(key, '')
          });
          inp.addEventListener('input', () => store.set(key, inp.value));
          line.appendChild(inp);
        }
      });
      wrap.appendChild(line);
      return wrap;
    },

    ligneAvecFleche(b, store) {
      const wrap = h('div', { class:'de-q' });
      const line = h('div', { class:'de-q-label', html: b.html });
      // Suppose que le HTML se termine par un texte "→" ; on ajoute l'input.
      const inp = h('input', {
        type:'text', class:'de-blank-inline',
        style:{ width: b.width },
        value: store.get(b.key, '')
      });
      inp.addEventListener('input', () => store.set(b.key, inp.value));
      line.appendChild(inp);
      wrap.appendChild(line);
      return wrap;
    },

    choixInline(b, store) {
      const wrap = h('div', { class:'de-q' });
      const line = h('div', { class:'de-q-label' });
      if (b.avant) line.appendChild(document.createTextNode(b.avant + ' '));
      const grp = h('span', { class:'de-choices' });
      b.choix.forEach(c => {
        const btn = h('button', { type:'button', text: c, 'data-val': c });
        if (store.get(b.key) === c) btn.classList.add('de-on');
        btn.addEventListener('click', () => {
          grp.querySelectorAll('button').forEach(x => x.classList.remove('de-on'));
          btn.classList.add('de-on');
          store.set(b.key, c);
        });
        grp.appendChild(btn);
      });
      line.appendChild(grp);
      if (b.apres) line.appendChild(document.createTextNode(' ' + b.apres));
      wrap.appendChild(line);
      return wrap;
    },

    vraiFaux(b, store) {
      const wrap = h('div', { class:'de-q', style:{marginTop:'4px'} });
      b.items.forEach(it => {
        const row = h('div', { class:'de-vf' });
        row.appendChild(h('div', { html: it.label }));
        const btnGroup = h('div', { class:'de-vf-buttons' });
        ['Vrai','Faux'].forEach(opt => {
          const btn = h('button', {
            class:'de-vf-btn', type:'button', text: opt, 'data-val': opt
          });
          if (store.get(it.key) === opt) btn.classList.add('de-on');
          btn.addEventListener('click', () => {
            btnGroup.querySelectorAll('button').forEach(x => x.classList.remove('de-on'));
            btn.classList.add('de-on');
            store.set(it.key, opt);
          });
          btnGroup.appendChild(btn);
        });
        row.appendChild(btnGroup);
        wrap.appendChild(row);
      });
      return wrap;
    },

    toggleGrille(b, store) {
      const wrap = h('div', { class:'de-q' });
      const grid = h('div', { class:'de-card-grid',
        style:{gridTemplateColumns: 'repeat(' + b.colonnes + ', 1fr)'} });
      b.items.forEach(it => {
        const card = h('div', { class:'de-card' });
        card.appendChild(h('span', { class:'de-word', text: it.label }));
        const tg = h('span', { class:'de-toggle' });
        b.options.forEach(opt => {
          const btn = h('button', { type:'button', text: opt, 'data-val': opt });
          if (store.get(it.key) === opt) btn.classList.add('de-on');
          btn.addEventListener('click', () => {
            tg.querySelectorAll('button').forEach(x => x.classList.remove('de-on'));
            btn.classList.add('de-on');
            store.set(it.key, opt);
          });
          tg.appendChild(btn);
        });
        card.appendChild(tg);
        grid.appendChild(card);
      });
      wrap.appendChild(grid);
      return wrap;
    },

    motsIntrus(b, store) {
      const wrap = h('div', { class:'de-q' });
      const list = h('div', { class:'de-word-list' });
      if (b.lblPrefix) list.appendChild(h('span', { class:'de-lbl', text: b.lblPrefix }));
      b.mots.forEach(m => {
        const chip = h('span', { class:'de-word-chip', text: m });
        if (store.get(b.key) === m) chip.classList.add('de-crossed');
        chip.addEventListener('click', () => {
          if (chip.classList.contains('de-crossed')) {
            chip.classList.remove('de-crossed');
            store.del(b.key);
          } else {
            list.querySelectorAll('.de-word-chip').forEach(x => x.classList.remove('de-crossed'));
            chip.classList.add('de-crossed');
            store.set(b.key, m);
          }
        });
        list.appendChild(chip);
      });
      wrap.appendChild(list);
      return wrap;
    },

    motsChips(b, store) {
      const wrap = h('div', { class:'de-q' });
      const list = h('div', { class:'de-word-list' });
      if (b.lblPrefix) list.appendChild(h('span', { class:'de-lbl', text: b.lblPrefix }));
      const cur = store.get(b.key, b.mode === 'multi' ? [] : null);
      const selected = new Set(b.mode === 'multi' ? cur : (cur ? [cur] : []));
      b.mots.forEach(m => {
        const chip = h('span', { class:'de-word-chip', text: m });
        if (selected.has(m)) chip.classList.add('de-selected');
        chip.addEventListener('click', () => {
          if (b.mode === 'multi') {
            if (selected.has(m)) { selected.delete(m); chip.classList.remove('de-selected'); }
            else { selected.add(m); chip.classList.add('de-selected'); }
            store.set(b.key, Array.from(selected));
          } else {
            list.querySelectorAll('.de-word-chip').forEach(x => x.classList.remove('de-selected'));
            chip.classList.add('de-selected');
            store.set(b.key, m);
          }
        });
        list.appendChild(chip);
      });
      wrap.appendChild(list);
      return wrap;
    },

    paires(b, store) {
      const wrap = h('div', { class:'de-q' });
      const pairs = h('div', { class:'de-pairs' });
      const left  = h('div', { class:'de-pairs-col' });
      const right = h('div', { class:'de-pairs-col' });

      function getState() {
        return store.get(b.key, { links: {}, sel: null });
      }
      function setState(s) { store.set(b.key, s); }

      function render() {
        left.innerHTML = ''; right.innerHTML = '';
        const s = getState();
        const links = s.links || {};
        const sel = s.sel;

        b.gauche.forEach(w => {
          const linkedTo = links[w];
          const el = h('div', {
            class:'de-pair-item' + (linkedTo ? ' de-linked' : ''),
            'data-side':'L', 'data-word': w
          });
          el.innerHTML = w + (linkedTo ? '<span class="de-linked-tag">↔ ' + linkedTo + '</span>' : '');
          el.addEventListener('click', () => clickPair('L', w));
          left.appendChild(el);
        });

        const rightLinked = new Set(Object.values(links));
        b.droite.forEach(w => {
          const isLinked = rightLinked.has(w);
          const el = h('div', {
            class:'de-pair-item' + (isLinked ? ' de-linked' : ''),
            'data-side':'R', 'data-word': w, text: w
          });
          el.addEventListener('click', () => clickPair('R', w));
          right.appendChild(el);
        });

        if (sel) {
          const elSel = (sel.side === 'L' ? left : right).querySelector(
            '[data-word="' + CSS.escape(sel.word) + '"]');
          if (elSel) elSel.classList.add('de-selected');
        }
      }

      function clickPair(side, word) {
        const s = getState();
        s.links = s.links || {};
        // déliage
        if (side === 'L' && s.links[word]) {
          delete s.links[word]; s.sel = null;
          setState(s); render(); return;
        }
        if (side === 'R' && Object.values(s.links).includes(word)) {
          for (const k of Object.keys(s.links)) if (s.links[k] === word) delete s.links[k];
          s.sel = null;
          setState(s); render(); return;
        }
        const sel = s.sel;
        if (!sel) { s.sel = { side, word }; setState(s); render(); return; }
        if (sel.side === side) { s.sel = { side, word }; setState(s); render(); return; }
        const leftW  = sel.side === 'L' ? sel.word : word;
        const rightW = sel.side === 'R' ? sel.word : word;
        s.links[leftW] = rightW;
        s.sel = null;
        setState(s); render();
      }

      pairs.appendChild(left); pairs.appendChild(right);
      wrap.appendChild(pairs);
      const reset = h('button', { class:'de-pairs-reset', type:'button',
        text:'↻ Recommencer' });
      reset.addEventListener('click', () => {
        store.set(b.key, { links: {}, sel: null });
        render();
      });
      wrap.appendChild(reset);
      render();
      return wrap;
    },

    fractionAColorier(b, store) {
      const wrap = h('div', { class:'de-q' });
      if (b.label) wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      if (b.consigne) wrap.appendChild(h('p', { class:'de-consigne', text: b.consigne }));
      const bar = h('div', { class:'de-fraction-bar' });
      const filled = new Set(store.get(b.key, []));
      for (let i = 0; i < b.parts; i++) {
        const cell = h('div', { class:'de-fill-toggle' + (filled.has(i) ? ' de-filled' : '') });
        cell.addEventListener('click', () => {
          if (filled.has(i)) { filled.delete(i); cell.classList.remove('de-filled'); }
          else { filled.add(i); cell.classList.add('de-filled'); }
          store.set(b.key, Array.from(filled).sort((a,b)=>a-b));
        });
        bar.appendChild(cell);
      }
      wrap.appendChild(bar);
      return wrap;
    },

    fractionDonnee(b) {
      const wrap = h('div', { class:'de-q' });
      if (b.label) wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      const bar = h('div', { class:'de-fraction-bar' });
      for (let i = 0; i < b.den; i++) {
        bar.appendChild(h('div', { class: i < b.num ? 'de-filled' : '' }));
      }
      wrap.appendChild(bar);
      return wrap;
    },

    svg(b) {
      const wrap = h('div', { class:'de-svg-wrap' });
      const div = h('div', { html: b.svgContent });
      wrap.appendChild(div);
      if (b.caption) {
        wrap.appendChild(h('div', { class:'de-consigne',
          style:{margin:'8px 0 0', borderLeft:'none', paddingLeft:0, textAlign:'center'},
          text: b.caption }));
      }
      return wrap;
    },

    // ----- HORLOGES analogiques -----
    horloges(b) {
      const tailles = { sm: 100, md: 130, lg: 160 };
      const px = tailles[b.taille] || tailles.md;
      const wrap = h('div', { class:'de-svg-wrap de-horloges' });
      const grid = h('div', {
        style: {
          display:'flex', flexWrap:'wrap', gap:'18px',
          justifyContent:'center', alignItems:'flex-start'
        }
      });
      b.horloges.forEach(hg => {
        const heure = ((hg.heure % 12) + 12) % 12;     // 0..11
        const minutes = ((hg.minutes || 0) % 60 + 60) % 60;  // 0..59
        // Angles : 12 = 0°, sens horaire ; aiguille des heures avance avec les minutes
        const angleH = (heure + minutes / 60) * 30;     // 360 / 12
        const angleM = minutes * 6;                     // 360 / 60
        // SVG dans un viewBox 120x140 ; cadran centré en (60,70), rayon 55
        const cx = 60, cy = 70, r = 55;
        const toXY = (ang, len) => {
          const rad = (ang - 90) * Math.PI / 180; // -90 pour que 0° pointe vers le haut
          return [cx + Math.cos(rad) * len, cy + Math.sin(rad) * len];
        };
        const [hx, hy] = toXY(angleH, 30);
        const [mx, my] = toXY(angleM, 42);
        let graduations = '';
        if (b.graduationsMinutes) {
          for (let i = 0; i < 60; i++) {
            const isMajor = (i % 5 === 0);
            const [x1, y1] = toXY(i * 6, r - (isMajor ? 6 : 3));
            const [x2, y2] = toXY(i * 6, r);
            graduations +=
              '<line x1="' + x1.toFixed(2) + '" y1="' + y1.toFixed(2) +
              '" x2="' + x2.toFixed(2) + '" y2="' + y2.toFixed(2) +
              '" stroke="#1f2937" stroke-width="' + (isMajor ? 1.5 : 0.8) + '"/>';
          }
        }
        const labelLetter = hg.label
          ? '<text x="60" y="138" text-anchor="middle" font-size="13" font-weight="700" fill="#1f2937">' +
            String(hg.label).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</text>'
          : '';
        const svgStr =
          '<svg viewBox="0 0 120 ' + (hg.label ? 145 : 130) +
          '" width="' + px + '" height="' + Math.round(px * (hg.label ? 145 : 130) / 120) + '">' +
            '<circle cx="60" cy="70" r="55" fill="#fff" stroke="#1f2937" stroke-width="2.5"/>' +
            graduations +
            // Chiffres 12/3/6/9
            '<text x="60" y="22"  text-anchor="middle" font-size="11" font-weight="700" fill="#1f2937">12</text>' +
            '<text x="108" y="74" text-anchor="middle" font-size="11" font-weight="700" fill="#1f2937">3</text>' +
            '<text x="60" y="124" text-anchor="middle" font-size="11" font-weight="700" fill="#1f2937">6</text>' +
            '<text x="12" y="74"  text-anchor="middle" font-size="11" font-weight="700" fill="#1f2937">9</text>' +
            // Aiguille des heures (plus courte, plus épaisse)
            '<line x1="60" y1="70" x2="' + hx.toFixed(2) + '" y2="' + hy.toFixed(2) +
            '" stroke="#1f2937" stroke-width="3.5" stroke-linecap="round"/>' +
            // Aiguille des minutes (plus longue, plus fine)
            '<line x1="60" y1="70" x2="' + mx.toFixed(2) + '" y2="' + my.toFixed(2) +
            '" stroke="#1f2937" stroke-width="2.2" stroke-linecap="round"/>' +
            // Pivot central
            '<circle cx="60" cy="70" r="3" fill="#1f2937"/>' +
            labelLetter +
          '</svg>';
        const cell = h('div', {
          style: { textAlign:'center' },
          html: svgStr
        });
        grid.appendChild(cell);
      });
      wrap.appendChild(grid);
      return wrap;
    },

    // ----- DIAGRAMME À BANDES -----
    diagrammeBandes(b) {
      const donnees = b.donnees || [];
      if (donnees.length === 0) {
        return h('div', { class:'de-svg-wrap', text:'(diagramme vide)' });
      }
      // Échelle : si max non fourni, on prend le max des valeurs et on arrondit au pas supérieur
      const valMax = Math.max.apply(null, donnees.map(d => d.valeur));
      let pas = b.pas;
      if (!pas) {
        // Choix automatique de pas selon le max
        pas = (valMax <= 5)   ? 1 :
              (valMax <= 20)  ? 2 :
              (valMax <= 50)  ? 5 :
              (valMax <= 100) ? 10 : 20;
      }
      let yMax = b.max;
      if (!yMax) {
        yMax = Math.ceil(valMax / pas) * pas;
        if (yMax === valMax) yMax += pas; // un peu d'air au-dessus
      }

      // Layout SVG : largeur fixe, hauteur calculée
      // Marges : left 50 (graduations Y), right 20, top 30 (titre), bottom 50 (labels X)
      const nbBarres = donnees.length;
      const largeurBarre = 50;
      const gapBarre = 14;
      const chartW = nbBarres * largeurBarre + (nbBarres - 1) * gapBarre;
      const W = 60 + chartW + 30;             // gauche + zone + droite
      const H = 240;
      const padL = 60, padR = 20, padT = 30, padB = 60;
      const plotH = H - padT - padB;          // hauteur de l'aire de tracé
      const plotW = W - padL - padR;

      // Y -> pixel
      const yToPx = v => padT + plotH * (1 - v / yMax);

      // Graduations Y
      let gradY = '';
      for (let v = 0; v <= yMax; v += pas) {
        const y = yToPx(v);
        gradY +=
          '<line x1="' + (padL - 4) + '" y1="' + y.toFixed(2) +
          '" x2="' + padL + '" y2="' + y.toFixed(2) + '" stroke="#1f2937" stroke-width="1"/>' +
          '<text x="' + (padL - 8) + '" y="' + (y + 3.5).toFixed(2) +
          '" text-anchor="end" font-size="10" fill="#1f2937">' + v + '</text>';
      }

      // Barres
      let barres = '';
      donnees.forEach((d, i) => {
        const x = padL + 10 + i * (largeurBarre + gapBarre);
        const yTop = yToPx(d.valeur);
        const barH = (padT + plotH) - yTop;
        barres +=
          '<rect x="' + x + '" y="' + yTop.toFixed(2) +
          '" width="' + largeurBarre + '" height="' + barH.toFixed(2) +
          '" class="de-bar-fill" stroke="#1f2937" stroke-width="1.5"/>' +
          '<text x="' + (x + largeurBarre / 2) + '" y="' + (padT + plotH + 16) +
          '" text-anchor="middle" font-size="11" font-weight="600" fill="#1f2937">' +
          String(d.categorie).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) +
          '</text>';
      });

      // Titre et axes
      const titre = b.titre
        ? '<text x="' + (W/2) + '" y="18" text-anchor="middle" font-size="13" font-weight="700" fill="#1f2937">' +
          String(b.titre).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</text>'
        : '';
      const axeY = b.axeY
        ? '<text x="14" y="' + (padT + plotH/2) + '" text-anchor="middle" font-size="10" fill="#1f2937" ' +
          'transform="rotate(-90 14 ' + (padT + plotH/2) + ')">' +
          String(b.axeY).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</text>'
        : '';
      const axeX = b.axeX
        ? '<text x="' + (W/2) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#1f2937">' +
          String(b.axeX).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</text>'
        : '';

      const svgStr =
        '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + Math.min(W, 460) + 'px; display:block; margin:0 auto;">' +
          titre + axeY + axeX +
          // Axes
          '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '" stroke="#1f2937" stroke-width="2"/>' +
          '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (padT + plotH) + '" stroke="#1f2937" stroke-width="2"/>' +
          gradY + barres +
        '</svg>';

      const wrap = h('div', { class:'de-svg-wrap de-diagramme-bandes' });
      wrap.appendChild(h('div', { html: svgStr }));
      return wrap;
    },

    // ----- THERMOMÈTRES -----
    thermometres(b, store) {
      const wrap = h('div', { class:'de-svg-wrap de-thermometres' });
      const grid = h('div', {
        style: {
          display:'flex', flexWrap:'wrap', gap:'20px',
          justifyContent:'center', alignItems:'flex-start'
        }
      });
      const range = b.max - b.min;
      b.items.forEach(item => {
        const t = Math.max(b.min, Math.min(b.max, item.temperature));
        // Tube : SVG 70x200. Tube va de y=15 à y=170. Bulbe en bas.
        const tubeTop = 15;
        const tubeBot = 170;
        const tubeH = tubeBot - tubeTop;
        // Hauteur de remplissage en fonction de t
        const ratio = (t - b.min) / range; // 0..1
        const fillTop = tubeBot - ratio * tubeH;
        // Graduations principales (par b.graduation)
        let graduations = '';
        for (let v = b.min; v <= b.max; v += b.graduation) {
          const y = tubeBot - ((v - b.min) / range) * tubeH;
          graduations +=
            '<line x1="22" y1="' + y.toFixed(1) + '" x2="32" y2="' + y.toFixed(1) +
            '" stroke="#1f2937" stroke-width="1.5"/>' +
            '<text x="38" y="' + (y + 3.5).toFixed(1) + '" font-size="9" font-weight="700" fill="#1f2937">' +
            v + '</text>';
        }
        // Petites graduations intermédiaires
        const sub = b.graduation / 5;
        for (let v = b.min; v <= b.max; v += sub) {
          if ((v - b.min) % b.graduation === 0) continue;
          const y = tubeBot - ((v - b.min) / range) * tubeH;
          graduations +=
            '<line x1="25" y1="' + y.toFixed(1) + '" x2="32" y2="' + y.toFixed(1) +
            '" stroke="#6b7280" stroke-width="0.6"/>';
        }
        const labelText = item.label
          ? '<text x="40" y="195" text-anchor="middle" font-size="13" font-weight="700" fill="#1f2937">' +
            String(item.label).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</text>'
          : '';
        const svgStr =
          '<svg viewBox="0 0 80 205" width="80" height="205">' +
            // °C en haut
            '<text x="40" y="11" text-anchor="middle" font-size="9" font-weight="700" fill="#1f2937">°C</text>' +
            // Contour du tube
            '<rect x="28" y="' + tubeTop + '" width="8" height="' + tubeH +
              '" rx="4" ry="4" fill="#fff" stroke="#1f2937" stroke-width="1.5"/>' +
            // Bulbe
            '<circle cx="32" cy="178" r="9" fill="#fff" stroke="#1f2937" stroke-width="1.5"/>' +
            // Liquide rouge
            '<rect x="29.5" y="' + fillTop.toFixed(1) +
              '" width="5" height="' + (tubeBot - fillTop).toFixed(1) +
              '" fill="#dc2626"/>' +
            '<circle cx="32" cy="178" r="7" fill="#dc2626"/>' +
            graduations +
            labelText +
          '</svg>';
        const cell = h('div', { style: { textAlign:'center' } });
        cell.appendChild(h('div', { html: svgStr }));
        if (item.key) {
          const inputWrap = h('div', { style: { marginTop:'4px', display:'flex',
            alignItems:'center', justifyContent:'center', gap:'4px' } });
          const inp = h('input', { type:'text',
            style: { width:'56px', textAlign:'center', padding:'4px 6px' },
            value: store.get(item.key, '') });
          inp.addEventListener('input', () => store.set(item.key, inp.value));
          inputWrap.appendChild(inp);
          inputWrap.appendChild(h('span', { text:'°C',
            style: { fontWeight:'700', color:'#1f2937' } }));
          cell.appendChild(inputWrap);
        }
        grid.appendChild(cell);
      });
      wrap.appendChild(grid);
      return wrap;
    },

    // ----- PLAN CARTÉSIEN -----
    planCartesien(b) {
      const wrap = h('div', { class:'de-svg-wrap de-plan-cartesien' });
      // Paramètres du SVG
      const cellPx = 28;
      const padL = 30, padB = 30, padT = 15, padR = 15;
      const plotW = b.maxX * cellPx;
      const plotH = b.maxY * cellPx;
      const W = padL + plotW + padR;
      const H = padT + plotH + padB;
      const x0 = padL;
      const y0 = padT + plotH; // y=0 du plan correspond au bas

      // Grille
      let grid = '';
      for (let i = 0; i <= b.maxX; i++) {
        const x = x0 + i * cellPx;
        grid += '<line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + y0 +
                '" stroke="' + (i === 0 ? '#1f2937' : '#d1d5db') +
                '" stroke-width="' + (i === 0 ? '1.5' : '0.6') + '"/>';
      }
      for (let j = 0; j <= b.maxY; j++) {
        const y = y0 - j * cellPx;
        grid += '<line x1="' + x0 + '" y1="' + y + '" x2="' + (x0 + plotW) + '" y2="' + y +
                '" stroke="' + (j === 0 ? '#1f2937' : '#d1d5db') +
                '" stroke-width="' + (j === 0 ? '1.5' : '0.6') + '"/>';
      }
      // Étiquettes des axes
      let labels = '';
      for (let i = 0; i <= b.maxX; i++) {
        labels += '<text x="' + (x0 + i * cellPx) + '" y="' + (y0 + 16) +
                  '" text-anchor="middle" font-size="11" font-weight="700" fill="#1f2937">' +
                  i + '</text>';
      }
      for (let j = 0; j <= b.maxY; j++) {
        labels += '<text x="' + (x0 - 8) + '" y="' + (y0 - j * cellPx + 4) +
                  '" text-anchor="end" font-size="11" font-weight="700" fill="#1f2937">' +
                  j + '</text>';
      }
      // Flèches sur les axes
      const arrows =
        '<polygon points="' + (x0 + plotW) + ',' + y0 + ' ' +
          (x0 + plotW + 8) + ',' + (y0 - 4) + ' ' +
          (x0 + plotW + 8) + ',' + (y0 + 4) + '" fill="#1f2937"/>' +
        '<polygon points="' + x0 + ',' + padT + ' ' +
          (x0 - 4) + ',' + (padT + 8) + ' ' +
          (x0 + 4) + ',' + (padT + 8) + '" fill="#1f2937"/>';

      // Points pré-placés (montrés)
      let points = '';
      (b.points || []).forEach(p => {
        const px = x0 + p.x * cellPx;
        const py = y0 - p.y * cellPx;
        points += '<circle cx="' + px + '" cy="' + py + '" r="4" fill="#1f2937"/>';
        if (p.label) {
          points += '<text x="' + (px + 7) + '" y="' + (py - 5) +
                    '" font-size="12" font-weight="700" fill="#1f2937">' +
                    String(p.label).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) +
                    '</text>';
        }
      });

      const titre = b.titre
        ? '<text x="' + (W/2) + '" y="' + (padT - 2) +
          '" text-anchor="middle" font-size="12" font-weight="700" fill="#1f2937">' +
          String(b.titre).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) +
          '</text>'
        : '';

      const svgStr =
        '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" style="max-width:100%;height:auto">' +
          titre + grid + labels + arrows + points +
        '</svg>';

      wrap.appendChild(h('div', { html: svgStr, style: { textAlign:'center' } }));

      // Si points à placer : afficher la liste sous la grille
      if (b.aPlacer && b.aPlacer.length > 0) {
        const list = h('div', {
          class:'de-consigne',
          style: { margin:'10px 0 0', textAlign:'center',
                   borderLeft:'none', paddingLeft:0 },
          text: 'Place ces points sur le plan : ' + b.aPlacer.join('  ·  ')
        });
        wrap.appendChild(list);
      }
      return wrap;
    },

    // ----- GRILLE DE DESSIN INTERACTIVE -----
    // L'enfant trace des polygones (carrés, rectangles, polygones libres)
    // sur une grille quadrillée. Les sommets s'accrochent automatiquement
    // aux intersections de la grille (snap-to-grid), et chaque segment est
    // contraint à un angle de 0°, 45° ou 90° par rapport au sommet précédent.
    grilleDessin(b, store) {
      const wrap = h('div', { class:'de-q de-grille-dessin-wrap' });
      if (b.label)    wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      if (b.consigne) wrap.appendChild(h('p', { class:'de-consigne', text: b.consigne }));

      const cellPx = b.cellPx || 30;
      const padL = 28, padR = 14, padT = b.titre ? 28 : 14, padB = 22;
      const plotW = b.cols * cellPx;
      const plotH = b.rows * cellPx;
      const W = padL + plotW + padR;
      const H = padT + plotH + padB;
      const x0 = padL;
      const y0 = padT + plotH; // y=0 du plan = bas

      // -- Données persistées : { polygones:{ id: { points:[[x,y],...], ferme:bool } }, enclosActif }
      function defaultState() {
        const polys = {};
        (b.enclos || []).forEach(e => { polys[e.id] = { points: [], ferme: false }; });
        return {
          polygones: polys,
          enclosActif: (b.enclos && b.enclos[0]) ? b.enclos[0].id : null
        };
      }
      let state = store.get(b.key, null);
      if (!state || typeof state !== 'object' || !state.polygones) {
        state = defaultState();
      }
      // Garantir qu'on a un slot par enclos (utile si la conf a changé)
      (b.enclos || []).forEach(e => {
        if (!state.polygones[e.id]) state.polygones[e.id] = { points: [], ferme: false };
      });
      if (!state.enclosActif && b.enclos && b.enclos[0]) {
        state.enclosActif = b.enclos[0].id;
      }
      function persist() { store.set(b.key, state); }

      // -- Barre d'outils : sélection de l'enclos + boutons utilitaires
      const toolbar = h('div', { class: 'de-gd-toolbar' });
      const chipsRow = h('div', { class: 'de-gd-chips' });
      const enclosById = {};
      (b.enclos || []).forEach(e => { enclosById[e.id] = e; });

      function refreshChips() {
        chipsRow.querySelectorAll('.de-gd-chip').forEach(ch => {
          const id = ch.getAttribute('data-id');
          if (id === state.enclosActif) ch.classList.add('de-gd-chip-active');
          else ch.classList.remove('de-gd-chip-active');
          // Affichage du nombre de points / fermé
          const poly = state.polygones[id];
          const badge = ch.querySelector('.de-gd-chip-badge');
          if (badge) {
            if (poly && poly.ferme) badge.textContent = '✓';
            else if (poly && poly.points.length > 0) badge.textContent = poly.points.length;
            else badge.textContent = '';
          }
        });
      }

      (b.enclos || []).forEach(e => {
        const chip = h('button', {
          class: 'de-gd-chip',
          'data-id': e.id,
          type: 'button',
          style: { '--de-gd-couleur': e.couleur }
        });
        const dot = h('span', { class: 'de-gd-chip-dot',
                                style: { background: e.couleur } });
        const name = h('span', { class: 'de-gd-chip-name', html: e.nom });
        const badge = h('span', { class: 'de-gd-chip-badge' });
        chip.appendChild(dot);
        chip.appendChild(name);
        chip.appendChild(badge);
        chip.addEventListener('click', () => {
          state.enclosActif = e.id;
          persist();
          refreshChips();
          redraw();
        });
        chipsRow.appendChild(chip);
      });
      toolbar.appendChild(chipsRow);

      // Boutons utilitaires
      const btnRow = h('div', { class: 'de-gd-btn-row' });
      const btnUndo = h('button', { class: 'de-gd-btn', type: 'button',
                                    html: '↩️ Annuler le point' });
      const btnClearOne = h('button', { class: 'de-gd-btn', type: 'button',
                                        html: '✖️ Effacer cet enclos' });
      const btnClearAll = h('button', { class: 'de-gd-btn de-gd-btn-danger', type: 'button',
                                        html: '🗑️ Tout effacer' });

      // -- Bannière de confirmation inline (remplace window.confirm() qui peut
      //    être bloqué dans certaines WebViews mobiles).
      //    Apparaît sous les boutons quand on demande une confirmation.
      const confirmBar = h('div', { class: 'de-gd-confirm', style: { display: 'none' } });
      const confirmMsg = h('span', { class: 'de-gd-confirm-msg' });
      const confirmYes = h('button', { class: 'de-gd-btn de-gd-btn-confirm-yes',
                                        type: 'button', html: '✓ Oui, effacer' });
      const confirmNo = h('button', { class: 'de-gd-btn',
                                       type: 'button', html: 'Annuler' });
      confirmBar.appendChild(confirmMsg);
      confirmBar.appendChild(confirmYes);
      confirmBar.appendChild(confirmNo);

      let pendingAction = null;
      function showConfirm(message, action) {
        confirmMsg.textContent = message;
        pendingAction = action;
        confirmBar.style.display = 'flex';
      }
      function hideConfirm() {
        confirmBar.style.display = 'none';
        pendingAction = null;
      }
      confirmYes.addEventListener('click', () => {
        const a = pendingAction;
        hideConfirm();
        if (a) a();
      });
      confirmNo.addEventListener('click', hideConfirm);

      btnUndo.addEventListener('click', () => {
        hideConfirm();
        const poly = state.polygones[state.enclosActif];
        if (!poly) return;
        if (poly.ferme) { poly.ferme = false; persist(); redraw(); refreshChips(); return; }
        if (poly.points.length === 0) return;
        poly.points.pop();
        persist(); redraw(); refreshChips();
      });
      btnClearOne.addEventListener('click', () => {
        const id = state.enclosActif;
        if (!id) return;
        const poly = state.polygones[id];
        const hasContent = poly && (poly.ferme || poly.points.length > 0);
        if (!hasContent) { hideConfirm(); return; }
        const nom = (enclosById[id] && enclosById[id].nom) || 'cet enclos';
        const nomTexte = String(nom).replace(/<[^>]+>/g, '');
        showConfirm('Effacer le dessin de « ' + nomTexte + ' » ?', () => {
          state.polygones[id] = { points: [], ferme: false };
          persist(); redraw(); refreshChips();
        });
      });
      btnClearAll.addEventListener('click', () => {
        // Vérifier s'il y a quelque chose à effacer
        const aDuContenu = (b.enclos || []).some(e => {
          const p = state.polygones[e.id];
          return p && (p.ferme || p.points.length > 0);
        });
        if (!aDuContenu) { hideConfirm(); return; }
        showConfirm('Effacer TOUS les enclos du plan ?', () => {
          (b.enclos || []).forEach(e => { state.polygones[e.id] = { points: [], ferme: false }; });
          persist(); redraw(); refreshChips();
        });
      });
      btnRow.appendChild(btnUndo);
      btnRow.appendChild(btnClearOne);
      btnRow.appendChild(btnClearAll);
      toolbar.appendChild(btnRow);
      toolbar.appendChild(confirmBar);

      wrap.appendChild(toolbar);

      // -- Conteneur SVG
      const svgWrap = h('div', { class: 'de-gd-svgwrap',
                                  style: { maxWidth: W + 'px' } });
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('class', 'de-gd-svg');
      svg.setAttribute('width', W);
      svg.setAttribute('height', H);
      svg.style.maxWidth = '100%';
      svg.style.height = 'auto';
      svg.style.touchAction = 'manipulation';

      // Helpers de conversion (grille ↔ pixel)
      function gridToPx(gx, gy) {
        return { px: x0 + gx * cellPx, py: y0 - gy * cellPx };
      }
      // Forcer un point candidat à respecter l'angle 0/45/90 par rapport
      // à un point d'ancrage (le sommet précédent du polygone en cours).
      // Stratégie : on calcule les 4 directions possibles (H, V, D+, D-)
      // et on prend la projection la plus proche du point candidat brut.
      function contraindreAngle(ancre, candidat) {
        const dx = candidat[0] - ancre[0];
        const dy = candidat[1] - ancre[1];
        // 4 candidats contraints
        const adx = Math.abs(dx), ady = Math.abs(dy);
        const cands = [
          [ancre[0] + dx, ancre[1]],            // horizontal
          [ancre[0],      ancre[1] + dy],       // vertical
        ];
        // Diagonale 45° : on prend la plus petite des deux distances
        const d = Math.min(adx, ady) * (dx === 0 ? 1 : Math.sign(dx));
        const e = Math.min(adx, ady) * (dy === 0 ? 1 : Math.sign(dy));
        cands.push([ancre[0] + d, ancre[1] + e]);
        // Choix : minimiser distance au candidat brut
        let best = cands[0], bestDist = Infinity;
        for (const c of cands) {
          const ddx = c[0] - candidat[0], ddy = c[1] - candidat[1];
          const dist = ddx*ddx + ddy*ddy;
          if (dist < bestDist) { bestDist = dist; best = c; }
        }
        return best;
      }

      // Gestion du clic / tap sur la grille
      function handlePointer(ev) {
        ev.preventDefault();
        const enclosId = state.enclosActif;
        if (!enclosId) return;
        const poly = state.polygones[enclosId];
        if (!poly) return;
        if (poly.ferme) {
          // Polygone déjà fermé : ne rien faire (l'enfant doit cliquer Annuler)
          return;
        }
        // Position du clic dans le système viewBox
        const rect = svg.getBoundingClientRect();
        const xPt = (ev.clientX != null ? ev.clientX
                     : (ev.touches && ev.touches[0] ? ev.touches[0].clientX : 0));
        const yPt = (ev.clientY != null ? ev.clientY
                     : (ev.touches && ev.touches[0] ? ev.touches[0].clientY : 0));
        const scaleX = W / rect.width;
        const scaleY = H / rect.height;
        const px = (xPt - rect.left) * scaleX;
        const py = (yPt - rect.top)  * scaleY;
        // Conversion px → coords grille (sans contrainte d'angle pour l'instant)
        let gx = Math.round((px - x0) / cellPx);
        let gy = Math.round((y0 - py) / cellPx);
        // Bornes
        gx = Math.max(0, Math.min(b.cols, gx));
        gy = Math.max(0, Math.min(b.rows, gy));

        // Si on a déjà des points : contrainte d'angle par rapport au dernier
        let candidat = [gx, gy];
        if (poly.points.length > 0) {
          const dernier = poly.points[poly.points.length - 1];
          candidat = contraindreAngle(dernier, candidat);
          // Rebornage après contrainte (au cas où la diagonale dépasse)
          candidat[0] = Math.max(0, Math.min(b.cols, candidat[0]));
          candidat[1] = Math.max(0, Math.min(b.rows, candidat[1]));
        }
        // Si on a au moins 3 points et que le candidat tombe (presque) sur le premier point,
        // on ferme le polygone
        if (poly.points.length >= 3) {
          const p0 = poly.points[0];
          if (Math.abs(candidat[0] - p0[0]) < 0.5 && Math.abs(candidat[1] - p0[1]) < 0.5) {
            poly.ferme = true;
            persist();
            redraw();
            refreshChips();
            return;
          }
        }
        // Sinon, on ajoute le point. (Évite les doublons immédiats.)
        if (poly.points.length > 0) {
          const dern = poly.points[poly.points.length - 1];
          if (dern[0] === candidat[0] && dern[1] === candidat[1]) return;
        }
        poly.points.push(candidat);
        persist();
        redraw();
        refreshChips();
      }
      svg.addEventListener('click', handlePointer);
      // (Pas besoin d'écouter touchstart séparément : sur tablette, le click
      // est déjà émis sans délai grâce au viewport meta + touch-action.)

      // -- Fonction de redessin du contenu SVG
      function redraw() {
        // Vider le SVG, puis le reconstruire
        while (svg.firstChild) svg.removeChild(svg.firstChild);

        // Fond blanc
        const bg = document.createElementNS(svgNS, 'rect');
        bg.setAttribute('x', 0); bg.setAttribute('y', 0);
        bg.setAttribute('width', W); bg.setAttribute('height', H);
        bg.setAttribute('fill', '#FFFFFF');
        svg.appendChild(bg);

        // Titre éventuel
        if (b.titre) {
          const t = document.createElementNS(svgNS, 'text');
          t.setAttribute('x', W / 2);
          t.setAttribute('y', padT - 10);
          t.setAttribute('text-anchor', 'middle');
          t.setAttribute('font-size', '12');
          t.setAttribute('font-weight', '700');
          t.setAttribute('fill', '#1f2937');
          t.textContent = b.titre;
          svg.appendChild(t);
        }

        // Quadrillage
        for (let i = 0; i <= b.cols; i++) {
          const x = x0 + i * cellPx;
          const ln = document.createElementNS(svgNS, 'line');
          ln.setAttribute('x1', x); ln.setAttribute('y1', padT);
          ln.setAttribute('x2', x); ln.setAttribute('y2', y0);
          ln.setAttribute('stroke', i === 0 ? '#1f2937' : '#d8e0e6');
          ln.setAttribute('stroke-width', i === 0 ? '1.5' : '0.5');
          svg.appendChild(ln);
        }
        for (let j = 0; j <= b.rows; j++) {
          const y = y0 - j * cellPx;
          const ln = document.createElementNS(svgNS, 'line');
          ln.setAttribute('x1', x0); ln.setAttribute('y1', y);
          ln.setAttribute('x2', x0 + plotW); ln.setAttribute('y2', y);
          ln.setAttribute('stroke', j === 0 ? '#1f2937' : '#d8e0e6');
          ln.setAttribute('stroke-width', j === 0 ? '1.5' : '0.5');
          svg.appendChild(ln);
        }

        // Étiquettes d'axes (pour aider l'enfant à compter)
        for (let i = 0; i <= b.cols; i++) {
          if (i % 2 !== 0 && b.cols > 14) continue; // alléger si très large
          const t = document.createElementNS(svgNS, 'text');
          t.setAttribute('x', x0 + i * cellPx);
          t.setAttribute('y', y0 + 14);
          t.setAttribute('text-anchor', 'middle');
          t.setAttribute('font-size', '10');
          t.setAttribute('fill', '#4b5563');
          t.textContent = i;
          svg.appendChild(t);
        }
        for (let j = 0; j <= b.rows; j++) {
          if (j % 2 !== 0 && b.rows > 10) continue;
          const t = document.createElementNS(svgNS, 'text');
          t.setAttribute('x', x0 - 6);
          t.setAttribute('y', y0 - j * cellPx + 3);
          t.setAttribute('text-anchor', 'end');
          t.setAttribute('font-size', '10');
          t.setAttribute('fill', '#4b5563');
          t.textContent = j;
          svg.appendChild(t);
        }

        // Tracer chaque polygone (les fermés d'abord, les ouverts en dernier
        // pour que les segments en cours soient bien visibles au-dessus)
        const ordre = [];
        (b.enclos || []).forEach(e => {
          const poly = state.polygones[e.id];
          if (poly && poly.ferme) ordre.push(e);
        });
        (b.enclos || []).forEach(e => {
          const poly = state.polygones[e.id];
          if (poly && !poly.ferme) ordre.push(e);
        });

        ordre.forEach(e => {
          const poly = state.polygones[e.id];
          if (!poly || poly.points.length === 0) return;
          const couleur = e.couleur || '#94a3b8';

          if (poly.ferme && poly.points.length >= 3) {
            // Polygone rempli
            const polyEl = document.createElementNS(svgNS, 'polygon');
            const pts = poly.points.map(p => {
              const { px, py } = gridToPx(p[0], p[1]);
              return px + ',' + py;
            }).join(' ');
            polyEl.setAttribute('points', pts);
            polyEl.setAttribute('fill', couleur);
            polyEl.setAttribute('fill-opacity', '0.32');
            polyEl.setAttribute('stroke', couleur);
            polyEl.setAttribute('stroke-width', '2.5');
            polyEl.setAttribute('stroke-linejoin', 'round');
            svg.appendChild(polyEl);

            // Étiquette au centroïde
            let cx = 0, cy = 0;
            poly.points.forEach(p => {
              const { px, py } = gridToPx(p[0], p[1]);
              cx += px; cy += py;
            });
            cx /= poly.points.length;
            cy /= poly.points.length;
            // Fond blanc derrière le texte pour lisibilité
            const labelTxt = String(e.nom || e.id);
            const t = document.createElementNS(svgNS, 'text');
            t.setAttribute('x', cx);
            t.setAttribute('y', cy + 4);
            t.setAttribute('text-anchor', 'middle');
            t.setAttribute('font-size', '13');
            t.setAttribute('font-weight', '700');
            t.setAttribute('fill', '#1f2937');
            t.setAttribute('paint-order', 'stroke');
            t.setAttribute('stroke', '#FFFFFF');
            t.setAttribute('stroke-width', '3');
            t.setAttribute('stroke-linejoin', 'round');
            t.textContent = labelTxt;
            svg.appendChild(t);
          } else {
            // Polygone ouvert : tracer la polyline
            const isActive = (state.enclosActif === e.id);
            const lineW = isActive ? 3 : 2;
            const dash = isActive ? '0' : '5 4';
            if (poly.points.length >= 2) {
              const pl = document.createElementNS(svgNS, 'polyline');
              const pts = poly.points.map(p => {
                const { px, py } = gridToPx(p[0], p[1]);
                return px + ',' + py;
              }).join(' ');
              pl.setAttribute('points', pts);
              pl.setAttribute('fill', 'none');
              pl.setAttribute('stroke', couleur);
              pl.setAttribute('stroke-width', lineW);
              pl.setAttribute('stroke-linejoin', 'round');
              pl.setAttribute('stroke-linecap', 'round');
              if (dash !== '0') pl.setAttribute('stroke-dasharray', dash);
              svg.appendChild(pl);
            }
            // Sommets
            poly.points.forEach((p, idx) => {
              const { px, py } = gridToPx(p[0], p[1]);
              const c = document.createElementNS(svgNS, 'circle');
              c.setAttribute('cx', px); c.setAttribute('cy', py);
              // Premier sommet plus gros pour le distinguer (zone de fermeture)
              c.setAttribute('r', idx === 0 && isActive ? '7' : '4.5');
              c.setAttribute('fill', '#FFFFFF');
              c.setAttribute('stroke', couleur);
              c.setAttribute('stroke-width', idx === 0 && isActive ? '2.5' : '2');
              svg.appendChild(c);
            });
          }
        });

        // Petit pointeur indiquant qu'on peut cliquer
        svg.style.cursor = 'crosshair';
      }
      redraw();

      svgWrap.appendChild(svg);
      wrap.appendChild(svgWrap);

      // Petite aide affichée sous la grille
      const aide = h('div', {
        class: 'de-gd-aide',
        html: '<b>Pour dessiner :</b> 1) touche un enclos dans la barre, ' +
              '2) touche les sommets sur la grille, ' +
              '3) touche à nouveau le premier sommet pour <b>fermer</b> ton polygone. ' +
              'Les lignes s\'accrochent toutes seules (angles droits ou 45°).'
      });
      wrap.appendChild(aide);

      refreshChips();
      return wrap;
    },

    // ----- GRILLE D'AIRES (figures à compter) -----
    grilleAires(b) {
      const wrap = h('div', { class:'de-svg-wrap de-grille-aires' });
      const cellPx = 26;
      const pad = 6;
      const W = b.cols * cellPx + pad * 2;
      const H = b.rows * cellPx + pad * 2;
      // Grille de base
      let grid = '<rect x="' + pad + '" y="' + pad + '" width="' + (b.cols * cellPx) +
                 '" height="' + (b.rows * cellPx) + '" fill="#fff" stroke="#1f2937" stroke-width="1.5"/>';
      for (let i = 1; i < b.cols; i++) {
        grid += '<line x1="' + (pad + i * cellPx) + '" y1="' + pad +
                '" x2="' + (pad + i * cellPx) + '" y2="' + (pad + b.rows * cellPx) +
                '" stroke="#9ca3af" stroke-width="0.5"/>';
      }
      for (let j = 1; j < b.rows; j++) {
        grid += '<line x1="' + pad + '" y1="' + (pad + j * cellPx) +
                '" x2="' + (pad + b.cols * cellPx) + '" y2="' + (pad + j * cellPx) +
                '" stroke="#9ca3af" stroke-width="0.5"/>';
      }
      // Figures
      let figs = '';
      const couleurs = ['#374151', '#4b5563', '#6b7280', '#9ca3af'];
      (b.figures || []).forEach((fig, idx) => {
        const fill = fig.couleur || couleurs[idx % couleurs.length];
        // Coloriage des cellules
        (fig.cellules || []).forEach(c => {
          const cx = pad + c[0] * cellPx;
          const cy = pad + c[1] * cellPx;
          figs += '<rect x="' + cx + '" y="' + cy + '" width="' + cellPx +
                  '" height="' + cellPx + '" fill="' + fill + '" opacity="0.55"/>';
        });
        // Numéro de la figure (au centre approximatif)
        if (fig.num != null && fig.cellules && fig.cellules.length > 0) {
          const xs = fig.cellules.map(c => c[0]);
          const ys = fig.cellules.map(c => c[1]);
          const cx = pad + (Math.min.apply(null, xs) + Math.max.apply(null, xs) + 1) / 2 * cellPx;
          const cy = pad + (Math.min.apply(null, ys) + Math.max.apply(null, ys) + 1) / 2 * cellPx;
          figs += '<circle cx="' + cx + '" cy="' + cy + '" r="10" fill="#fff" stroke="#1f2937" stroke-width="1.5"/>' +
                  '<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="12" font-weight="700" fill="#1f2937">' +
                  fig.num + '</text>';
        }
      });
      const svgStr =
        '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" style="max-width:100%;height:auto">' +
          grid + figs +
        '</svg>';
      wrap.appendChild(h('div', { html: svgStr, style: { textAlign:'center' } }));
      return wrap;
    },

    // ----- OPÉRATION POSÉE EN COLONNE -----
    operationColonne(b, store) {
      const wrap = h('div', { class:'de-q de-op-colonne' });
      if (b.label) wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      // On aligne les deux opérandes à droite. On calcule la largeur max en
      // nombre de caractères (chiffres + virgule).
      const o1 = String(b.operande1);
      const o2 = String(b.operande2);
      const width = Math.max(o1.length, o2.length, (o1.length + o2.length)) + 1;
      // Construire chaque ligne comme une suite de "cases" de chiffres
      function ligneToCells(s, padLeft) {
        const cells = [];
        for (let i = 0; i < padLeft; i++) cells.push(' ');
        for (let i = 0; i < s.length; i++) cells.push(s[i]);
        return cells;
      }
      const cells1 = ligneToCells(o1, width - o1.length);
      const cells2 = ligneToCells(o2, width - o2.length);

      const table = h('div', { class:'de-op-table' });

      function makeRow(cells, opChar) {
        const row = h('div', { class:'de-op-row' });
        const opCell = h('div', { class:'de-op-cell de-op-operateur', text: opChar || '' });
        row.appendChild(opCell);
        cells.forEach(ch => {
          const cls = (ch === ',' || ch === '.') ? 'de-op-cell de-op-virgule' : 'de-op-cell';
          row.appendChild(h('div', { class: cls, text: ch === ' ' ? '' : ch }));
        });
        return row;
      }

      table.appendChild(makeRow(cells1, ''));
      table.appendChild(makeRow(cells2, b.operateur));
      // Trait
      const traitRow = h('div', { class:'de-op-row de-op-trait' });
      traitRow.appendChild(h('div', { class:'de-op-cell de-op-operateur' }));
      for (let i = 0; i < cells1.length; i++) {
        traitRow.appendChild(h('div', { class:'de-op-cell de-op-trait-cell' }));
      }
      table.appendChild(traitRow);
      // Ligne de saisie : un input par chiffre
      const inputRow = h('div', { class:'de-op-row' });
      inputRow.appendChild(h('div', { class:'de-op-cell de-op-operateur' }));
      for (let i = 0; i < cells1.length; i++) {
        const k = b.key + '_' + i;
        const inp = h('input', { type:'text', maxlength: '1',
          class:'de-op-input',
          value: store.get(k, '') });
        inp.addEventListener('input', () => store.set(k, inp.value));
        const cell = h('div', { class:'de-op-cell' });
        cell.appendChild(inp);
        inputRow.appendChild(cell);
      }
      table.appendChild(inputRow);

      wrap.appendChild(table);
      return wrap;
    },

    // ----- 20) FRACTION CERCLE -----
    fractionCercle(b, store) {
      const wrap = h('div', { class:'de-q' });
      if (b.label)   wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      if (b.consigne) wrap.appendChild(h('p', { class:'de-consigne', text: b.consigne }));

      const tailles = { sm: 90, md: 130, lg: 170 };
      const px = tailles[b.taille] || tailles.md;
      const cx = px / 2, cy = px / 2, r = px / 2 - 4;
      const parts = Math.max(2, b.parts | 0);
      const filled = new Set(store.get(b.key, []));

      function secteur(i) {
        const a1 = -Math.PI / 2 + (i / parts) * 2 * Math.PI;
        const a2 = -Math.PI / 2 + ((i + 1) / parts) * 2 * Math.PI;
        const x1 = cx + r * Math.cos(a1);
        const y1 = cy + r * Math.sin(a1);
        const x2 = cx + r * Math.cos(a2);
        const y2 = cy + r * Math.sin(a2);
        const largeArc = ((a2 - a1) > Math.PI) ? 1 : 0;
        return 'M ' + cx + ' ' + cy +
               ' L ' + x1.toFixed(2) + ' ' + y1.toFixed(2) +
               ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' 1 ' +
               x2.toFixed(2) + ' ' + y2.toFixed(2) + ' Z';
      }

      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + px + ' ' + px);
      svg.setAttribute('width',  px);
      svg.setAttribute('height', px);
      svg.setAttribute('class', 'de-fraction-cercle-svg');

      const bg = document.createElementNS(svgNS, 'circle');
      bg.setAttribute('cx', cx); bg.setAttribute('cy', cy); bg.setAttribute('r', r);
      bg.setAttribute('fill', '#FFFFFF');
      svg.appendChild(bg);

      for (let i = 0; i < parts; i++) {
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', secteur(i));
        path.setAttribute('class', 'de-fraction-cercle-part' +
          (filled.has(i) ? ' de-filled' : ''));
        path.addEventListener('click', () => {
          if (filled.has(i)) {
            filled.delete(i);
            path.classList.remove('de-filled');
          } else {
            filled.add(i);
            path.classList.add('de-filled');
          }
          store.set(b.key, Array.from(filled).sort((x,y) => x - y));
        });
        svg.appendChild(path);
      }

      const border = document.createElementNS(svgNS, 'circle');
      border.setAttribute('cx', cx); border.setAttribute('cy', cy); border.setAttribute('r', r);
      border.setAttribute('fill', 'none');
      border.setAttribute('stroke', 'currentColor');
      border.setAttribute('stroke-width', '1.5');
      border.setAttribute('class', 'de-fraction-cercle-border');
      svg.appendChild(border);

      const center = h('div', { class:'de-fraction-cercle-wrap' });
      center.appendChild(svg);
      wrap.appendChild(center);
      return wrap;
    },

    // ----- 21) DÉCOMPOSITION ADDITIVE -----
    decomposition(b, store) {
      const wrap = h('div', { class:'de-q de-decomp' });
      if (b.label) {
        wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      }

      // Formatage typographique : « 4 275 » avec espace fine insécable
      function formatNombre(n) {
        if (n == null) return '';
        const s = String(n);
        const parts = s.split(/[.,]/);
        const ent = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '\u202F');
        return parts.length > 1 ? ent + ',' + parts[1] : ent;
      }

      const eqn = h('div', { class:'de-decomp-eqn' });

      eqn.appendChild(h('span', {
        class:'de-decomp-nombre',
        text: formatNombre(b.nombre)
      }));
      eqn.appendChild(h('span', { class:'de-decomp-op', text:'=' }));

      const n = Math.min(b.positions.length, b.keys.length);
      for (let i = 0; i < n; i++) {
        const stack = h('div', { class:'de-decomp-stack' });
        const inp = h('input', {
          type: 'text',
          maxlength: '7',
          class: 'de-decomp-input',
          inputmode: 'numeric',
          value: store.get(b.keys[i], '')
        });
        inp.addEventListener('input', () => store.set(b.keys[i], inp.value));
        stack.appendChild(inp);
        stack.appendChild(h('div', { class:'de-decomp-pos', text: b.positions[i] }));
        eqn.appendChild(stack);

        if (i < n - 1) {
          const plus = h('div', { class:'de-decomp-plus-stack' });
          plus.appendChild(h('span', { class:'de-decomp-op', text:'+' }));
          plus.appendChild(h('div', { class:'de-decomp-pos-spacer' }));
          eqn.appendChild(plus);
        }
      }

      wrap.appendChild(eqn);
      return wrap;
    },

    // ----- 22) LIGNE NUMÉRIQUE -----
    ligneNumerique(b, store) {
      const wrap = h('div', { class:'de-q' });
      if (b.label) wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));

      const W = 560, H = 90;
      const padX = 30, axisY = 50;
      const min = b.min, max = b.max, range = max - min;
      const xFor = v => padX + ((v - min) / range) * (W - 2 * padX);

      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('class', 'de-ligne-numerique');
      svg.style.maxWidth = '100%';
      svg.style.height = 'auto';
      svg.style.width = '100%';

      const axis = document.createElementNS(svgNS, 'line');
      axis.setAttribute('x1', padX - 6); axis.setAttribute('y1', axisY);
      axis.setAttribute('x2', W - padX + 6); axis.setAttribute('y2', axisY);
      axis.setAttribute('stroke', 'currentColor'); axis.setAttribute('stroke-width', '1.5');
      svg.appendChild(axis);
      [[padX - 6, -1], [W - padX + 6, 1]].forEach(arr => {
        const x = arr[0], dir = arr[1];
        const tri = document.createElementNS(svgNS, 'polygon');
        const dx = 6 * dir;
        tri.setAttribute('points',
          x + ',' + axisY + ' ' +
          (x - dx) + ',' + (axisY - 4) + ' ' +
          (x - dx) + ',' + (axisY + 4));
        tri.setAttribute('fill', 'currentColor');
        svg.appendChild(tri);
      });

      if (b.pasMineur) {
        for (let v = min; v <= max + 0.0001; v += b.pasMineur) {
          if (Math.abs(((v - min) % b.pas)) < 0.0001) continue;
          const x = xFor(v);
          const tick = document.createElementNS(svgNS, 'line');
          tick.setAttribute('x1', x); tick.setAttribute('y1', axisY - 4);
          tick.setAttribute('x2', x); tick.setAttribute('y2', axisY + 4);
          tick.setAttribute('stroke', 'currentColor');
          tick.setAttribute('stroke-width', '0.8');
          tick.setAttribute('opacity', '0.45');
          svg.appendChild(tick);
        }
      }

      const epsilon = 0.0001;
      for (let v = min; v <= max + epsilon; v += b.pas) {
        const x = xFor(v);
        const tick = document.createElementNS(svgNS, 'line');
        tick.setAttribute('x1', x); tick.setAttribute('y1', axisY - 8);
        tick.setAttribute('x2', x); tick.setAttribute('y2', axisY + 8);
        tick.setAttribute('stroke', 'currentColor');
        tick.setAttribute('stroke-width', '1.5');
        svg.appendChild(tick);

        let afficher = false;
        if (b.etiquettes === 'principales') afficher = true;
        else if (b.etiquettes === 'extremes') {
          afficher = Math.abs(v - min) < epsilon || Math.abs(v - max) < epsilon;
        }
        if (afficher) {
          const txt = document.createElementNS(svgNS, 'text');
          txt.setAttribute('x', x); txt.setAttribute('y', axisY + 24);
          txt.setAttribute('text-anchor', 'middle');
          txt.setAttribute('font-family', 'var(--de-font-body)');
          txt.setAttribute('font-size', '13');
          txt.setAttribute('fill', 'currentColor');
          txt.textContent = (Math.round(v * 100) / 100).toString().replace('.', ',');
          svg.appendChild(txt);
        }
      }

      const inputZones = [];
      (b.marques || []).forEach(m => {
        if (m.valeur == null) return;
        const x = xFor(m.valeur);
        const arrow = document.createElementNS(svgNS, 'path');
        arrow.setAttribute('d',
          'M ' + x + ' ' + (axisY - 4) +
          ' L ' + (x - 5) + ' ' + (axisY - 14) +
          ' L ' + (x + 5) + ' ' + (axisY - 14) + ' Z');
        arrow.setAttribute('fill', 'var(--de-accent)');
        svg.appendChild(arrow);
        if (m.label) {
          const txt = document.createElementNS(svgNS, 'text');
          txt.setAttribute('x', x); txt.setAttribute('y', axisY - 18);
          txt.setAttribute('text-anchor', 'middle');
          txt.setAttribute('font-family', 'var(--de-font-display)');
          txt.setAttribute('font-weight', '700');
          txt.setAttribute('font-size', '14');
          txt.setAttribute('fill', 'var(--de-accent)');
          txt.textContent = m.label;
          svg.appendChild(txt);
        }
        if (m.key) inputZones.push({ key: m.key, x: x });
      });

      const center = h('div', { class:'de-ligne-numerique-wrap' });
      center.appendChild(svg);

      if (inputZones.length) {
        const inputs = h('div', { class:'de-ligne-numerique-inputs' });
        inputZones.forEach(z => {
          const pct = (z.x / W) * 100;
          const slot = h('div', {
            class:'de-ln-slot',
            style: { left: 'calc(' + pct.toFixed(2) + '% - 22px)' }
          });
          const inp = h('input', { type:'text', maxlength:'5',
            class:'de-ln-input',
            value: store.get(z.key, '') });
          inp.addEventListener('input', () => store.set(z.key, inp.value));
          slot.appendChild(inp);
          inputs.appendChild(slot);
        });
        center.appendChild(inputs);
      }

      wrap.appendChild(center);
      return wrap;
    },

    // ----- 23) GLISSER-DÉPOSER PAR CATÉGORIES (tap-to-place) -----
    glisserDeposerCategories(b, store) {
      const wrap = h('div', { class:'de-q de-tri-wrap' });
      if (b.consigne) {
        wrap.appendChild(h('p', { class:'de-consigne', text: b.consigne }));
      } else {
        wrap.appendChild(h('p', { class:'de-consigne',
          text:'Touche une étiquette, puis touche la catégorie où la placer. ' +
               'Touche-la de nouveau dans la catégorie pour la retirer.' }));
      }

      const placement = store.get(b.key, {});
      b.items.forEach(it => { if (placement[it] == null) placement[it] = null; });
      let selection = null;

      const source = h('div', { class:'de-tri-source' });
      source.appendChild(h('div', { class:'de-tri-zone-title', text: 'À classer' }));
      const sourceBag = h('div', { class:'de-tri-bag' });
      source.appendChild(sourceBag);

      const zones = h('div', { class:'de-tri-zones' });
      const bagsByCat = {};
      b.categories.forEach(cat => {
        const z = h('div', { class:'de-tri-zone' });
        z.appendChild(h('div', { class:'de-tri-zone-title', text: cat }));
        const bag = h('div', { class:'de-tri-bag' });
        z.appendChild(bag);
        bagsByCat[cat] = bag;
        z.addEventListener('click', () => {
          if (selection) {
            placement[selection] = cat;
            selection = null;
            persist(); render();
          }
        });
        zones.appendChild(z);
      });

      wrap.appendChild(source);
      wrap.appendChild(zones);

      function persist() { store.set(b.key, placement); }

      function makeChip(item) {
        const chip = h('button', {
          class: 'de-tri-chip' + (selection === item ? ' de-selected' : ''),
          type: 'button',
          text: item
        });
        chip.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (placement[item] != null) {
            placement[item] = null;
            persist(); render();
            return;
          }
          selection = (selection === item) ? null : item;
          render();
        });
        return chip;
      }

      function render() {
        sourceBag.innerHTML = '';
        Object.keys(bagsByCat).forEach(c => { bagsByCat[c].innerHTML = ''; });
        b.items.forEach(it => {
          const cat = placement[it];
          const chip = makeChip(it);
          if (cat == null) sourceBag.appendChild(chip);
          else if (bagsByCat[cat]) bagsByCat[cat].appendChild(chip);
        });
        if (!sourceBag.children.length) {
          sourceBag.appendChild(h('span', {
            class:'de-tri-empty', text:'Toutes les étiquettes sont classées ✨'
          }));
        }
      }

      render();
      return wrap;
    },

    // ----- 24) FRACTION COLLECTION -----
    fractionCollection(b, store) {
      const wrap = h('div', { class:'de-q' });
      if (b.label)    wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      if (b.consigne) wrap.appendChild(h('p', { class:'de-consigne', text: b.consigne }));

      const couleurVar = {
        accent: 'var(--de-accent)',
        gold:   'var(--de-gold)',
        green:  'var(--de-green)'
      }[b.couleur] || 'var(--de-accent)';

      function cellSvg(coloriee) {
        const fill = coloriee ? couleurVar : '#FFFFFF';
        const stroke = 'var(--de-ink-soft)';
        if (b.formes === 'carres') {
          return '<svg viewBox="0 0 28 28" width="28" height="28">' +
            '<rect x="2" y="2" width="24" height="24" rx="3"' +
              ' fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"/>' +
          '</svg>';
        }
        if (b.formes === 'etoiles') {
          return '<svg viewBox="0 0 28 28" width="28" height="28">' +
            '<polygon points="14,2 17.3,10.2 26,10.7 19.2,16.3 21.5,24.8 14,20 6.5,24.8 8.8,16.3 2,10.7 10.7,10.2"' +
              ' fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"' +
              ' stroke-linejoin="round"/>' +
          '</svg>';
        }
        return '<svg viewBox="0 0 28 28" width="28" height="28">' +
          '<circle cx="14" cy="14" r="11" fill="' + fill + '"' +
            ' stroke="' + stroke + '" stroke-width="1.5"/>' +
        '</svg>';
      }

      const grille = h('div', { class:'de-fc-grille' });
      (b.items || []).forEach(it => {
        const colorie = (it === 'x' || it === true || it === 1);
        const cell = h('span', { class:'de-fc-cell', html: cellSvg(colorie) });
        grille.appendChild(cell);
      });
      wrap.appendChild(grille);

      const fracBox = h('div', { class:'de-fc-fraction' });
      const fracBlock = h('div', { class:'de-fc-stack' });
      const num = h('input', { type:'text', maxlength:'3',
        class:'de-fc-input', inputmode:'numeric',
        value: store.get(b.key + '_num', '') });
      num.addEventListener('input', () => store.set(b.key + '_num', num.value));
      const den = h('input', { type:'text', maxlength:'3',
        class:'de-fc-input', inputmode:'numeric',
        value: store.get(b.key + '_den', '') });
      den.addEventListener('input', () => store.set(b.key + '_den', den.value));
      fracBlock.appendChild(num);
      fracBlock.appendChild(h('div', { class:'de-fc-bar' }));
      fracBlock.appendChild(den);
      fracBox.appendChild(fracBlock);
      wrap.appendChild(fracBox);
      return wrap;
    },

    // ----- 25) SYMÉTRIE -----
    symetrie(b, store) {
      const wrap = h('div', { class:'de-q' });
      if (b.label)    wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      if (b.consigne) wrap.appendChild(h('p', { class:'de-consigne', text: b.consigne }));

      const W = 200, H = 200, cx = W/2, cy = H/2;
      const figW = 130, figH = 90;
      const x0 = cx - figW/2, y0 = cy - figH/2;

      let figureSvg = '';
      const figFill   = 'color-mix(in oklab, var(--de-accent-soft) 35%, #FFFFFF)';
      const figStroke = 'var(--de-ink-soft)';
      const sw = '2';
      if (typeof b.figure === 'string' && b.figure.trim().startsWith('<')) {
        figureSvg = b.figure;
      } else {
        switch (b.figure) {
          case 'carre':
            figureSvg = '<rect x="' + (cx - 55) + '" y="' + (cy - 55) + '" width="110" height="110"' +
              ' fill="' + figFill + '" stroke="' + figStroke + '" stroke-width="' + sw + '"/>';
            break;
          case 'triangleIsocele':
            figureSvg = '<polygon points="' +
              cx + ',' + (cy - 55) + ' ' +
              (cx - 55) + ',' + (cy + 45) + ' ' +
              (cx + 55) + ',' + (cy + 45) +
              '" fill="' + figFill + '" stroke="' + figStroke + '" stroke-width="' + sw + '" stroke-linejoin="round"/>';
            break;
          case 'triangleEquilateral': {
            const a = cx, b1 = cy - 50;
            const c = cx - 55, d = cy + 45;
            const e = cx + 55, f = cy + 45;
            figureSvg = '<polygon points="' + a + ',' + b1 + ' ' + c + ',' + d + ' ' + e + ',' + f + '"' +
              ' fill="' + figFill + '" stroke="' + figStroke + '" stroke-width="' + sw + '" stroke-linejoin="round"/>';
            break;
          }
          case 'losange':
            figureSvg = '<polygon points="' +
              cx + ',' + (cy - 55) + ' ' +
              (cx + 60) + ',' + cy + ' ' +
              cx + ',' + (cy + 55) + ' ' +
              (cx - 60) + ',' + cy +
              '" fill="' + figFill + '" stroke="' + figStroke + '" stroke-width="' + sw + '" stroke-linejoin="round"/>';
            break;
          case 'cercle':
            figureSvg = '<circle cx="' + cx + '" cy="' + cy + '" r="58"' +
              ' fill="' + figFill + '" stroke="' + figStroke + '" stroke-width="' + sw + '"/>';
            break;
          case 'lettreA':
            figureSvg = '<path d="M ' + (cx - 35) + ' ' + (cy + 50) +
              ' L ' + cx + ' ' + (cy - 55) +
              ' L ' + (cx + 35) + ' ' + (cy + 50) +
              ' M ' + (cx - 22) + ' ' + (cy + 15) +
              ' L ' + (cx + 22) + ' ' + (cy + 15) +
              '" fill="none" stroke="' + figStroke + '" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>';
            break;
          case 'lettreH':
            figureSvg = '<path d="M ' + (cx - 32) + ' ' + (cy - 50) +
              ' L ' + (cx - 32) + ' ' + (cy + 50) +
              ' M ' + (cx + 32) + ' ' + (cy - 50) +
              ' L ' + (cx + 32) + ' ' + (cy + 50) +
              ' M ' + (cx - 32) + ' ' + cy +
              ' L ' + (cx + 32) + ' ' + cy +
              '" fill="none" stroke="' + figStroke + '" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>';
            break;
          case 'coeur':
            figureSvg = '<path d="M ' + cx + ' ' + (cy + 50) +
              ' C ' + (cx - 70) + ' ' + (cy + 5) + ', ' +
              (cx - 70) + ' ' + (cy - 55) + ', ' +
              cx + ' ' + (cy - 15) +
              ' C ' + (cx + 70) + ' ' + (cy - 55) + ', ' +
              (cx + 70) + ' ' + (cy + 5) + ', ' +
              cx + ' ' + (cy + 50) +
              ' Z" fill="' + figFill + '" stroke="' + figStroke + '" stroke-width="' + sw + '" stroke-linejoin="round"/>';
            break;
          case 'rectangle':
          default:
            figureSvg = '<rect x="' + x0 + '" y="' + y0 + '" width="' + figW + '" height="' + figH + '"' +
              ' fill="' + figFill + '" stroke="' + figStroke + '" stroke-width="' + sw + '"/>';
        }
      }

      const selSet = new Set(store.get(b.key, []));
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('width', W);
      svg.setAttribute('height', H);
      svg.setAttribute('class', 'de-symetrie-svg');

      const frame = document.createElementNS(svgNS, 'rect');
      frame.setAttribute('x', '4'); frame.setAttribute('y', '4');
      frame.setAttribute('width', W - 8); frame.setAttribute('height', H - 8);
      frame.setAttribute('rx', '6');
      frame.setAttribute('fill', '#FFFFFF');
      frame.setAttribute('stroke', 'var(--de-rule)');
      frame.setAttribute('stroke-width', '1');
      svg.appendChild(frame);

      const figGroup = document.createElementNS(svgNS, 'g');
      figGroup.innerHTML = figureSvg;
      svg.appendChild(figGroup);

      function persistSel() {
        store.set(b.key, Array.from(selSet));
      }

      (b.axes || []).forEach(ax => {
        let coords;
        if (ax.type === 'horizontal') {
          coords = { x1: 10, y1: cy, x2: W - 10, y2: cy };
        } else if (ax.type === 'vertical') {
          coords = { x1: cx, y1: 10, x2: cx, y2: H - 10 };
        } else if (ax.type === 'diagonal') {
          const pente = ax.pente === -1 ? -1 : 1;
          const L = (W - 20) / 2;
          coords = {
            x1: cx - L, y1: cy - pente * L,
            x2: cx + L, y2: cy + pente * L
          };
        } else {
          coords = { x1: 10, y1: cy, x2: W - 10, y2: cy };
        }

        const line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', coords.x1); line.setAttribute('y1', coords.y1);
        line.setAttribute('x2', coords.x2); line.setAttribute('y2', coords.y2);
        line.setAttribute('class', 'de-symetrie-axis' +
          (selSet.has(ax.id) ? ' de-selected' : ''));
        line.setAttribute('data-id', ax.id);

        const hit = document.createElementNS(svgNS, 'line');
        hit.setAttribute('x1', coords.x1); hit.setAttribute('y1', coords.y1);
        hit.setAttribute('x2', coords.x2); hit.setAttribute('y2', coords.y2);
        hit.setAttribute('stroke', 'transparent');
        hit.setAttribute('stroke-width', '20');
        hit.setAttribute('stroke-linecap', 'round');
        hit.setAttribute('style', 'cursor:pointer');

        function toggle() {
          if (b.mode === 'single') {
            svg.querySelectorAll('.de-symetrie-axis').forEach(l => l.classList.remove('de-selected'));
            selSet.clear();
            selSet.add(ax.id);
            line.classList.add('de-selected');
          } else {
            if (selSet.has(ax.id)) {
              selSet.delete(ax.id);
              line.classList.remove('de-selected');
            } else {
              selSet.add(ax.id);
              line.classList.add('de-selected');
            }
          }
          persistSel();
        }
        line.addEventListener('click', toggle);
        hit.addEventListener('click', toggle);

        svg.appendChild(line);
        svg.appendChild(hit);
      });

      const center = h('div', { class:'de-symetrie-wrap' });
      center.appendChild(svg);
      wrap.appendChild(center);
      return wrap;
    },

    // ----- 26) DIAGRAMME À PICTOGRAMMES -----
    diagrammePictogrammes(b) {
      const donnees = b.donnees || [];
      if (donnees.length === 0) {
        return h('div', { class:'de-svg-wrap', text:'(diagramme vide)' });
      }

      const wrap = h('div', { class:'de-svg-wrap de-pictogrammes' });

      if (b.titre) {
        wrap.appendChild(h('div', { class:'de-picto-titre', text: b.titre }));
      }

      const table = h('div', { class:'de-picto-table' });
      donnees.forEach(d => {
        const row = h('div', { class:'de-picto-row' });
        row.appendChild(h('div', { class:'de-picto-cat', text: d.categorie }));
        const ic = h('div', { class:'de-picto-icones' });
        const u = b.valeurUnitaire || 1;
        const nbPleins  = Math.floor(d.valeur / u);
        const reste     = d.valeur - nbPleins * u;
        for (let i = 0; i < nbPleins; i++) {
          ic.appendChild(h('span', { class:'de-picto-icon', text: b.symbole }));
        }
        if (reste > 0) {
          ic.appendChild(h('span', { class:'de-picto-icon de-picto-half', text: b.symbole }));
        }
        row.appendChild(ic);
        table.appendChild(row);
      });
      wrap.appendChild(table);

      const legende = b.legende || (b.valeurUnitaire > 1
        ? ('1 ' + b.symbole + ' = ' + b.valeurUnitaire)
        : '');
      if (legende) {
        wrap.appendChild(h('div', { class:'de-picto-legende',
          html: legende.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) }));
      }

      return wrap;
    },

    // ----- 27) DIAGRAMME À LIGNE BRISÉE -----
    diagrammeLigneBrisee(b) {
      const donnees = b.donnees || [];
      if (donnees.length === 0) {
        return h('div', { class:'de-svg-wrap', text:'(diagramme vide)' });
      }

      const valeurs = donnees.map(d => d.valeur);
      const valMin = Math.min.apply(null, valeurs);
      const valMax = Math.max.apply(null, valeurs);

      let pas = b.pas;
      let yMin = (b.min != null) ? b.min : null;
      let yMax = (b.max != null) ? b.max : null;
      if (!pas) {
        const span = Math.max(1, Math.abs(valMax - valMin), Math.abs(valMax), Math.abs(valMin));
        pas = (span <= 5)   ? 1 :
              (span <= 20)  ? 2 :
              (span <= 50)  ? 5 :
              (span <= 100) ? 10 : 20;
      }
      if (yMin == null) {
        yMin = Math.floor(Math.min(valMin, 0) / pas) * pas;
        if (yMin === valMin && valMin !== 0) yMin -= pas;
      }
      if (yMax == null) {
        yMax = Math.ceil(valMax / pas) * pas;
        if (yMax === valMax) yMax += pas;
      }

      const nb = donnees.length;
      const padL = 50, padR = 24, padT = 30, padB = 56;
      const stepX = 60;
      const W = padL + (nb - 1) * stepX + padR + 20;
      const H = 240;
      const plotH = H - padT - padB;

      const yToPx = v => padT + plotH * (1 - (v - yMin) / (yMax - yMin));
      const xToPx = i => padL + 10 + i * stepX;

      let gradY = '';
      for (let v = yMin; v <= yMax + 0.0001; v += pas) {
        const y = yToPx(v);
        gradY +=
          '<line x1="' + (padL - 4) + '" y1="' + y.toFixed(2) +
          '" x2="' + (W - padR) + '" y2="' + y.toFixed(2) +
          '" stroke="' + (v === 0 ? '#1f2937' : '#d1d5db') +
          '" stroke-width="' + (v === 0 ? '1.3' : '0.6') + '"/>' +
          '<text x="' + (padL - 8) + '" y="' + (y + 3.5).toFixed(2) +
          '" text-anchor="end" font-size="10" fill="#1f2937">' + v + '</text>';
      }

      let labelsX = '';
      donnees.forEach((d, i) => {
        const x = xToPx(i);
        labelsX +=
          '<text x="' + x + '" y="' + (padT + plotH + 16) +
          '" text-anchor="middle" font-size="11" font-weight="600" fill="#1f2937">' +
          String(d.categorie).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) +
          '</text>';
      });

      const pts = donnees.map((d, i) => xToPx(i) + ',' + yToPx(d.valeur).toFixed(2)).join(' ');
      const poly = '<polyline points="' + pts + '" fill="none" stroke="var(--de-accent)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';

      let cercles = '';
      donnees.forEach((d, i) => {
        const x = xToPx(i);
        const y = yToPx(d.valeur);
        cercles +=
          '<circle cx="' + x + '" cy="' + y.toFixed(2) +
          '" r="4" fill="var(--de-accent)" stroke="#FFFFFF" stroke-width="1.5"/>';
        cercles +=
          '<text x="' + x + '" y="' + (y - 9).toFixed(2) +
          '" text-anchor="middle" font-size="10" font-weight="700" fill="#1f2937">' +
          d.valeur + '</text>';
      });

      const titre = b.titre
        ? '<text x="' + (W/2) + '" y="18" text-anchor="middle" font-size="13" font-weight="700" fill="#1f2937">' +
          String(b.titre).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</text>'
        : '';
      const axeY = b.axeY
        ? '<text x="14" y="' + (padT + plotH/2) + '" text-anchor="middle" font-size="10" fill="#1f2937" ' +
          'transform="rotate(-90 14 ' + (padT + plotH/2) + ')">' +
          String(b.axeY).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</text>'
        : '';
      const axeX = b.axeX
        ? '<text x="' + (W/2) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#1f2937">' +
          String(b.axeX).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</text>'
        : '';

      const svgStr =
        '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + Math.min(W, 520) + 'px; display:block; margin:0 auto;">' +
          titre + axeY + axeX +
          gradY +
          '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '" stroke="#1f2937" stroke-width="2"/>' +
          '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (padT + plotH) + '" stroke="#1f2937" stroke-width="2"/>' +
          labelsX +
          poly +
          cercles +
        '</svg>';

      const wrap = h('div', { class:'de-svg-wrap de-diagramme-ligne' });
      wrap.appendChild(h('div', { html: svgStr }));
      return wrap;
    },

    // ----- 28) NOMBRE MIXTE -----
    nombreMixte(b, store) {
      const wrap = h('div', { class:'de-q' });
      if (b.label)    wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      if (b.consigne) wrap.appendChild(h('p', { class:'de-consigne', text: b.consigne }));

      const box = h('div', { class:'de-nm-wrap' });

      if (b.entier) {
        const inpE = h('input', { type:'text', maxlength:'3',
          class:'de-nm-entier', inputmode:'numeric',
          value: store.get(b.key + '_ent', '') });
        inpE.addEventListener('input', () => store.set(b.key + '_ent', inpE.value));
        box.appendChild(inpE);
      }

      const stack = h('div', { class:'de-nm-stack' });
      const inpN = h('input', { type:'text', maxlength:'3',
        class:'de-nm-input', inputmode:'numeric',
        value: store.get(b.key + '_num', '') });
      inpN.addEventListener('input', () => store.set(b.key + '_num', inpN.value));
      const inpD = h('input', { type:'text', maxlength:'3',
        class:'de-nm-input', inputmode:'numeric',
        value: store.get(b.key + '_den', '') });
      inpD.addEventListener('input', () => store.set(b.key + '_den', inpD.value));
      stack.appendChild(inpN);
      stack.appendChild(h('div', { class:'de-nm-bar' }));
      stack.appendChild(inpD);
      box.appendChild(stack);

      wrap.appendChild(box);
      return wrap;
    },

    // ----- 29) ARGENT QUÉBÉCOIS -----
    argentQc(b, store) {
      const wrap = h('div', { class:'de-q' });
      if (b.label)    wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      if (b.consigne) wrap.appendChild(h('p', { class:'de-consigne', text: b.consigne }));

      // SVG pour chaque type de pièce/billet (style monochrome, ton sépia)
      function svgPiece(type) {
        // Pièces : cercle gris (argentée) ou doré (loonie/toonie)
        // Billets : rectangle coloré avec libellé
        const pieces = {
          '1c':  { kind:'coin', d:36, fill:'#C09060', txt:'1¢' },
          '5c':  { kind:'coin', d:42, fill:'#B8B8B0', txt:'5¢' },
          '10c': { kind:'coin', d:38, fill:'#B8B8B0', txt:'10¢' },
          '25c': { kind:'coin', d:46, fill:'#B8B8B0', txt:'25¢' },
          '1$':  { kind:'coin', d:50, fill:'#C99846', txt:'1 $' },
          '2$':  { kind:'coin', d:54, fill:'#C99846', ring:'#7B85A3', txt:'2 $' },
          '5$':  { kind:'bill', w:74, h:38, fill:'#5C7A8C', txt:'5 $' },
          '10$': { kind:'bill', w:74, h:38, fill:'#9456A4', txt:'10 $' },
          '20$': { kind:'bill', w:74, h:38, fill:'#6F8B5B', txt:'20 $' }
        };
        const p = pieces[type];
        if (!p) return '';
        if (p.kind === 'coin') {
          const r  = p.d / 2;
          const w  = p.d + 4;
          let inner = '';
          if (p.ring) {
            // toonie : anneau extérieur doré, centre argenté
            inner =
              '<circle cx="' + (w/2) + '" cy="' + (w/2) + '" r="' + r +
              '" fill="' + p.fill + '" stroke="#1f2937" stroke-width="1.2"/>' +
              '<circle cx="' + (w/2) + '" cy="' + (w/2) + '" r="' + (r - 5) +
              '" fill="' + p.ring + '" stroke="#1f2937" stroke-width="0.6"/>';
          } else {
            inner =
              '<circle cx="' + (w/2) + '" cy="' + (w/2) + '" r="' + r +
              '" fill="' + p.fill + '" stroke="#1f2937" stroke-width="1.2"/>';
          }
          return '<svg viewBox="0 0 ' + w + ' ' + w +
            '" width="' + w + '" height="' + w + '">' +
            inner +
            '<text x="' + (w/2) + '" y="' + (w/2 + 4) +
              '" text-anchor="middle" font-family="serif" font-weight="700"' +
              ' font-size="' + Math.round(p.d * 0.32) + '" fill="#1f2937">' +
              p.txt + '</text>' +
          '</svg>';
        }
        // Billet
        return '<svg viewBox="0 0 ' + (p.w + 4) + ' ' + (p.h + 4) +
          '" width="' + (p.w + 4) + '" height="' + (p.h + 4) + '">' +
          '<rect x="2" y="2" width="' + p.w + '" height="' + p.h +
            '" rx="3" fill="' + p.fill + '" stroke="#1f2937" stroke-width="1.2"/>' +
          '<rect x="6" y="6" width="' + (p.w - 8) + '" height="' + (p.h - 8) +
            '" rx="2" fill="none" stroke="#FFFFFF" stroke-width="0.8" opacity="0.65"/>' +
          '<text x="' + ((p.w + 4) / 2) + '" y="' + ((p.h + 4) / 2 + 5) +
            '" text-anchor="middle" font-family="serif" font-weight="700"' +
            ' font-size="14" fill="#FFFFFF">' + p.txt + '</text>' +
        '</svg>';
      }

      const grille = h('div', { class:'de-arg-grille' });
      (b.pieces || []).forEach(p => {
        const qte = Math.max(1, p.qte | 0);
        for (let i = 0; i < qte; i++) {
          const cell = h('span', { class:'de-arg-cell', html: svgPiece(p.type) });
          grille.appendChild(cell);
        }
      });
      wrap.appendChild(grille);

      // Champ réponse : un seul input + unité affichée
      if (b.key) {
        const ansLine = h('div', { class:'de-arg-reponse' });
        ansLine.appendChild(h('span', { class:'de-arg-eq', text: 'Total :' }));
        const inp = h('input', { type:'text', maxlength:'8',
          class:'de-arg-input', inputmode:'decimal',
          value: store.get(b.key, '') });
        inp.addEventListener('input', () => store.set(b.key, inp.value));
        ansLine.appendChild(inp);
        ansLine.appendChild(h('span', { class:'de-arg-unite',
          text: b.uniteResultat === '¢' ? '¢' : '$' }));
        wrap.appendChild(ansLine);
      }
      return wrap;
    },

    // ----- 30) CALENDRIER -----
    calendrier(b, store) {
      const wrap = h('div', { class:'de-q' });
      if (b.label)    wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      if (b.consigne) wrap.appendChild(h('p', { class:'de-consigne', text: b.consigne }));

      const mois  = Math.max(1, Math.min(12, b.mois | 0));
      const annee = b.annee | 0;
      const nomsMois = ['janvier','février','mars','avril','mai','juin',
                        'juillet','août','septembre','octobre','novembre','décembre'];
      // Jours selon début de semaine
      const joursLundi   = ['L','M','M','J','V','S','D'];
      const joursDimanche= ['D','L','M','M','J','V','S'];
      const debutLundi = (b.debutSemaine !== 'dimanche');
      const joursLabels = debutLundi ? joursLundi : joursDimanche;

      // Premier jour du mois (JS : 0 = dimanche, 1 = lundi, ... 6 = samedi)
      const d1 = new Date(annee, mois - 1, 1);
      let jourDeb = d1.getDay();                // 0..6 (dim..sam)
      if (debutLundi) jourDeb = (jourDeb + 6) % 7;   // 0..6 (lun..dim)

      // Nb de jours du mois
      const nbJours = new Date(annee, mois, 0).getDate();
      const marqueSet = new Set(b.marquer || []);

      const cal = h('div', { class:'de-cal' });
      cal.appendChild(h('div', { class:'de-cal-titre',
        text: nomsMois[mois - 1] + ' ' + annee }));

      const grid = h('div', { class:'de-cal-grid' });
      joursLabels.forEach(j => {
        grid.appendChild(h('div', { class:'de-cal-jour-tete', text: j }));
      });
      for (let i = 0; i < jourDeb; i++) {
        grid.appendChild(h('div', { class:'de-cal-cell de-cal-vide' }));
      }
      const selKey = b.key;
      const selected = selKey ? store.get(selKey, null) : null;
      for (let d = 1; d <= nbJours; d++) {
        const isMark = marqueSet.has(d);
        const isSel  = (selected != null && Number(selected) === d);
        const cell = h('div', {
          class: 'de-cal-cell'
            + (isMark ? ' de-cal-marque' : '')
            + (isSel  ? ' de-cal-selected' : ''),
          text: String(d)
        });
        if (b.mode === 'select' && selKey) {
          cell.style.cursor = 'pointer';
          cell.addEventListener('click', () => {
            // Toggle sélection
            const cur = store.get(selKey, null);
            if (cur != null && Number(cur) === d) {
              store.del(selKey);
            } else {
              store.set(selKey, d);
            }
            grid.querySelectorAll('.de-cal-cell').forEach(c => c.classList.remove('de-cal-selected'));
            if (store.get(selKey, null) === d) cell.classList.add('de-cal-selected');
          });
        }
        grid.appendChild(cell);
      }
      cal.appendChild(grid);
      wrap.appendChild(cal);
      return wrap;
    },

    // ----- 31) LIGNE DU TEMPS -----
    ligneTemps(b, store) {
      const wrap = h('div', { class:'de-q' });
      if (b.label)    wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      if (b.consigne) wrap.appendChild(h('p', { class:'de-consigne', text: b.consigne }));

      const W = 580, H = 110;
      const padX = 36, axisY = 70;
      const min = b.debut, max = b.fin, range = max - min;
      const xFor = v => padX + ((v - min) / range) * (W - 2 * padX);
      // Pas auto
      let pas = b.pas;
      if (!pas) {
        const span = Math.abs(range);
        pas = (span <= 20) ? 5 : (span <= 100) ? 10 : (span <= 500) ? 50 : 100;
      }

      // Construction du SVG en string (lecture seule pour la frise)
      let axis = '<line x1="' + (padX - 8) + '" y1="' + axisY +
        '" x2="' + (W - padX + 8) + '" y2="' + axisY +
        '" stroke="#1f2937" stroke-width="2"/>' +
        // Flèche droite
        '<polygon points="' + (W - padX + 8) + ',' + axisY + ' ' +
          (W - padX + 2) + ',' + (axisY - 5) + ' ' +
          (W - padX + 2) + ',' + (axisY + 5) + '" fill="#1f2937"/>';

      // Graduations
      let grads = '';
      for (let v = min; v <= max; v += pas) {
        const x = xFor(v);
        grads +=
          '<line x1="' + x.toFixed(1) + '" y1="' + (axisY - 5) +
          '" x2="' + x.toFixed(1) + '" y2="' + (axisY + 5) +
          '" stroke="#1f2937" stroke-width="1.5"/>' +
          '<text x="' + x.toFixed(1) + '" y="' + (axisY + 22) +
          '" text-anchor="middle" font-size="11" font-weight="700" fill="#1f2937">' +
          v + '</text>';
      }
      // Événements pré-placés
      let evts = '';
      (b.evenements || []).forEach((ev, i) => {
        if (ev.date == null) return;
        const x = xFor(ev.date);
        const aboveBelow = (i % 2 === 0) ? -1 : 1; // alterne au-dessus / en dessous
        const y0 = axisY + aboveBelow * 18;
        const y1 = axisY + aboveBelow * 32;
        evts +=
          '<circle cx="' + x.toFixed(1) + '" cy="' + axisY +
          '" r="4" fill="var(--de-accent)" stroke="#FFFFFF" stroke-width="1.5"/>' +
          '<line x1="' + x.toFixed(1) + '" y1="' + axisY +
          '" x2="' + x.toFixed(1) + '" y2="' + y0.toFixed(1) +
          '" stroke="var(--de-accent)" stroke-width="1.2" stroke-dasharray="2 2"/>' +
          '<text x="' + x.toFixed(1) + '" y="' + y1.toFixed(1) +
          '" text-anchor="middle" font-size="11" font-weight="700"' +
          ' font-family="var(--de-font-display)" fill="var(--de-accent)">' +
          (ev.date) + '</text>' +
          '<text x="' + x.toFixed(1) + '" y="' + (y1 + aboveBelow * 14).toFixed(1) +
          '" text-anchor="middle" font-size="10" font-weight="600" fill="#1f2937">' +
          String(ev.label || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) +
          '</text>';
      });

      // Hauteur dynamique selon le nombre d'événements
      const Hdyn = H + ((b.evenements && b.evenements.length > 4) ? 30 : 0);
      const svgStr =
        '<svg viewBox="0 0 ' + W + ' ' + Hdyn +
        '" width="100%" style="max-width:' + W + 'px; display:block; margin:0 auto;">' +
          axis + grads + evts +
        '</svg>';

      const center = h('div', { class:'de-lt-wrap', html: svgStr });
      wrap.appendChild(center);

      // Mode « à ordonner » : liste numérotée avec une case devant chaque
      // libellé. L'enfant écrit 1, 2, 3... dans l'ordre chronologique.
      if (b.aOrdonner && b.aOrdonner.length && b.key) {
        const list = h('div', { class:'de-lt-ordre' });
        list.appendChild(h('div', { class:'de-lt-ordre-titre',
          text: 'Écris l\'ordre chronologique (1 = le plus ancien) :' }));
        b.aOrdonner.forEach((ev, i) => {
          const row = h('div', { class:'de-lt-ordre-row' });
          const k = b.key + '_' + i;
          const inp = h('input', { type:'text', maxlength:'2',
            class:'de-lt-ordre-input', inputmode:'numeric',
            value: store.get(k, '') });
          inp.addEventListener('input', () => store.set(k, inp.value));
          row.appendChild(inp);
          row.appendChild(h('div', { class:'de-lt-ordre-label',
            text: ev.label || ('Événement ' + (i + 1)) }));
          list.appendChild(row);
        });
        wrap.appendChild(list);
      }
      return wrap;
    },

    // ----- 32) SCHÉMA ANNOTÉ -----
    schemaAnnote(b, store) {
      const wrap = h('div', { class:'de-q' });
      if (b.label)    wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      if (b.consigne) wrap.appendChild(h('p', { class:'de-consigne', text: b.consigne }));

      const stage = h('div', { class:'de-sa-stage',
        style: { height: (b.hauteur | 0) + 'px' } });

      // SVG de fond (fourni par l'agent)
      const bg = h('div', { class:'de-sa-bg', html: b.svg || '' });
      stage.appendChild(bg);

      // Points et étiquettes
      (b.points || []).forEach(p => {
        if (p.x == null || p.y == null || !p.key) return;
        const pin = h('div', { class:'de-sa-pin',
          style: { left: p.x + '%', top: p.y + '%' },
          text: String(p.label || '·') });
        stage.appendChild(pin);
      });

      wrap.appendChild(stage);

      // Liste des champs d'étiquetage en dessous
      if ((b.points || []).some(p => p.key)) {
        const list = h('div', { class:'de-sa-list' });
        (b.points || []).forEach(p => {
          if (!p.key) return;
          const row = h('div', { class:'de-sa-list-row' });
          row.appendChild(h('span', { class:'de-sa-list-num',
            text: String(p.label || '·') }));
          const inp = h('input', { type:'text',
            class:'de-sa-list-input',
            placeholder: 'écris le nom de cette partie',
            value: store.get(p.key, '') });
          inp.addEventListener('input', () => store.set(p.key, inp.value));
          row.appendChild(inp);
          list.appendChild(row);
        });
        wrap.appendChild(list);
      }
      return wrap;
    },

    // ----- 33) CYCLE DE VIE -----
    cycleVie(b, store) {
      const wrap = h('div', { class:'de-q' });
      if (b.label)    wrap.appendChild(h('div', { class:'de-q-label', html: b.label }));
      if (b.consigne) wrap.appendChild(h('p', { class:'de-consigne', text: b.consigne }));

      const etapes = (b.etapes || []).slice();
      const n = etapes.length;
      if (n < 2) {
        wrap.appendChild(h('p', { class:'de-consigne',
          text:'(cycle vide — fournir au moins 2 étapes)' }));
        return wrap;
      }

      // Disposition en cercle : centre (cx, cy), rayon R, étapes équidistantes
      const W = 380, H = 320;
      const cx = W / 2, cy = H / 2;
      const R = Math.min(W, H) / 2 - 70;
      const boiteW = 110, boiteH = 52;

      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('class', 'de-cyc-svg');
      svg.style.maxWidth = W + 'px';
      svg.style.width = '100%';
      svg.style.height = 'auto';

      // Lettres pour mode 'ordre' (A, B, C, D, E, F, G…)
      const letters = 'ABCDEFGHIJKL'.split('');

      // Coordonnées des étapes
      const positions = [];
      for (let i = 0; i < n; i++) {
        // Commence en haut (-PI/2), tourne dans le sens horaire
        const a = -Math.PI / 2 + (i / n) * 2 * Math.PI;
        positions.push({
          x: cx + R * Math.cos(a),
          y: cy + R * Math.sin(a),
          angle: a
        });
      }

      // Flèches courbes entre étapes consécutives (i → i+1, dernier → premier)
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const p1 = positions[i], p2 = positions[j];
        // Point d'arrivée légèrement en retrait pour la pointe de flèche
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len = Math.sqrt(dx*dx + dy*dy);
        const retrait = boiteW / 2 - 4;
        const p1Bord = { x: p1.x + (dx/len) * retrait, y: p1.y + (dy/len) * retrait };
        const p2Bord = { x: p2.x - (dx/len) * retrait, y: p2.y - (dy/len) * retrait };
        // Contrôle au milieu, décalé vers l'extérieur du cercle
        const mx = (p1Bord.x + p2Bord.x) / 2;
        const my = (p1Bord.y + p2Bord.y) / 2;
        const odx = mx - cx, ody = my - cy;
        const od = Math.sqrt(odx*odx + ody*ody) || 1;
        const offset = 28;
        const ctrlX = mx + (odx/od) * offset;
        const ctrlY = my + (ody/od) * offset;

        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d',
          'M ' + p1Bord.x.toFixed(1) + ' ' + p1Bord.y.toFixed(1) +
          ' Q ' + ctrlX.toFixed(1) + ' ' + ctrlY.toFixed(1) +
          ' '   + p2Bord.x.toFixed(1) + ' ' + p2Bord.y.toFixed(1));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'var(--de-accent)');
        path.setAttribute('stroke-width', '1.8');
        path.setAttribute('marker-end', 'url(#de-cyc-arrow)');
        svg.appendChild(path);
      }
      // Marker de flèche
      const defs = document.createElementNS(svgNS, 'defs');
      defs.innerHTML =
        '<marker id="de-cyc-arrow" viewBox="0 0 10 10" refX="8" refY="5"' +
        ' markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
        '<path d="M 0 0 L 10 5 L 0 10 Z" fill="var(--de-accent)"/>' +
        '</marker>';
      svg.appendChild(defs);

      // Boîtes des étapes
      etapes.forEach((et, i) => {
        const p = positions[i];
        const bx = p.x - boiteW / 2, by = p.y - boiteH / 2;
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', bx.toFixed(1));
        rect.setAttribute('y', by.toFixed(1));
        rect.setAttribute('width', boiteW);
        rect.setAttribute('height', boiteH);
        rect.setAttribute('rx', '8');
        rect.setAttribute('fill', '#FFFFFF');
        rect.setAttribute('stroke', 'var(--de-ink-soft)');
        rect.setAttribute('stroke-width', '1.5');
        svg.appendChild(rect);

        if (b.mode === 'ordre') {
          // Lettre en haut à gauche
          const letter = document.createElementNS(svgNS, 'text');
          letter.setAttribute('x', (bx + 10).toFixed(1));
          letter.setAttribute('y', (by + 16).toFixed(1));
          letter.setAttribute('font-family', 'var(--de-font-display)');
          letter.setAttribute('font-weight', '700');
          letter.setAttribute('font-size', '14');
          letter.setAttribute('fill', 'var(--de-accent)');
          letter.textContent = letters[i] + ')';
          svg.appendChild(letter);
        }

        const text = document.createElementNS(svgNS, 'text');
        text.setAttribute('x', p.x);
        text.setAttribute('y', p.y + (b.mode === 'ordre' ? 10 : 5));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-family', 'var(--de-font-body)');
        text.setAttribute('font-weight', '600');
        text.setAttribute('font-size', '13');
        text.setAttribute('fill', 'var(--de-ink)');
        text.textContent = et.label || '';
        svg.appendChild(text);
      });

      const center = h('div', { class:'de-cyc-wrap' });
      center.appendChild(svg);
      wrap.appendChild(center);

      // Mode ordre : cases d'ordre sous le cycle
      if (b.mode === 'ordre' && b.key) {
        const list = h('div', { class:'de-cyc-ordre' });
        list.appendChild(h('div', { class:'de-cyc-ordre-titre',
          text:'Écris l\'ordre des étapes du cycle (1 = première) :' }));
        etapes.forEach((et, i) => {
          const row = h('div', { class:'de-cyc-ordre-row' });
          row.appendChild(h('span', { class:'de-cyc-ordre-letter',
            text: letters[i] + ')' }));
          row.appendChild(h('span', { class:'de-cyc-ordre-label',
            text: et.label || '' }));
          const k = b.key + '_' + i;
          const inp = h('input', { type:'text', maxlength:'2',
            class:'de-cyc-ordre-input', inputmode:'numeric',
            value: store.get(k, '') });
          inp.addEventListener('input', () => store.set(k, inp.value));
          row.appendChild(inp);
          list.appendChild(row);
        });
        wrap.appendChild(list);
      }

      return wrap;
    },

    espace(b) {
      return h('div', { style: { height: b.px + 'px' } });
    }
  };

  // ========================================================================
  // DEVOIR — orchestrateur principal
  // ========================================================================
  function Devoir(opts) {
    this.opts = Object.assign({
      cible: 'body',
      eleve: 'Élève',
      type: 'devoir',          // 'devoir' ou 'examen'
      matiere: '',
      sujet: '',
      niveau: '',
      cycle: '',
      difficulte: 'Moyen',
      objectif: '',
      total: 0,
      storageKey: 'devoir_default',
      theme: 'default',        // 'default', 'aqua', 'forest', ...
      signoffTexte: ''
    }, opts);

    this.exercices  = [];
    this.bonusData  = null;
    this.store      = createStore(this.opts.storageKey);
    this.scoreEls   = {};      // num -> input element pour la correction
    this.modeCorrection = false;
  }

  Devoir.prototype.exercice = function(num, titre, points) {
    const ex = new Exercice(this, num, titre, points);
    this.exercices.push(ex);
    return ex;
  };

  Devoir.prototype.bonus = function(texte, points, keys) {
    // points : string (ex: '+2 pts')
    // keys : array de clés pour les blancs (ex: ['bonus1','bonus2','bonus3'])
    this.bonusData = { texte, points, keys: keys || ['bonus_libre'] };
    return this;
  };

  Devoir.prototype.signoff = function(texte) {
    this.opts.signoffTexte = texte;
    return this;
  };

  // ----- RENDU --------------------------------------------------------------
  Devoir.prototype.render = function() {
    const root = typeof this.opts.cible === 'string'
      ? document.querySelector(this.opts.cible) : this.opts.cible;
    if (!root) throw new Error('Devoir.render: cible introuvable');

    root.innerHTML = '';
    root.classList.add('de-app');
    if (this.opts.theme && this.opts.theme !== 'default') {
      root.setAttribute('data-theme', this.opts.theme);
    }

    // S'assurer que body porte la classe
    document.body.classList.add('de-body');

    // -- TOPBAR -------------------------------------------------------------
    const topbar = h('header', { class:'de-topbar' },
      h('div', { class:'de-topbar-inner' }, [
        h('div', { class:'de-crumb' }, [
          h('small', { text: (this.opts.type === 'examen' ? 'Examen' : 'Devoir')
            + (this.opts.sujet ? ' · ' + this.opts.sujet : '') }),
          document.createTextNode(this.opts.matiere),
          this._progressBar = h('span', { class:'de-progress-bar' })
        ]),
        this._scorePill = this._buildScorePill()
      ])
    );
    root.appendChild(topbar);

    // -- WRAP ---------------------------------------------------------------
    const wrap = h('main', { class:'de-wrap' });

    // -- HERO ---------------------------------------------------------------
    wrap.appendChild(this._buildHero());

    // -- TOGGLE MODE CORRECTION --------------------------------------------
    const toggleWrap = h('div', { class:'de-correct-toggle' });
    this._correctBtn = h('button', { class:'de-btn de-secondary', type:'button',
      text:'Mode correction (parent)' });
    this._correctBtn.addEventListener('click', () => this._toggleCorrection());
    toggleWrap.appendChild(this._correctBtn);
    wrap.appendChild(toggleWrap);

    // -- EXERCICES ----------------------------------------------------------
    this.exercices.forEach(ex => {
      wrap.appendChild(this._renderExercice(ex));
    });

    // -- BONUS --------------------------------------------------------------
    if (this.bonusData) wrap.appendChild(this._renderBonus());

    // -- SIGNOFF ------------------------------------------------------------
    if (this.opts.signoffTexte) {
      wrap.appendChild(h('p', { class:'de-signoff', text: this.opts.signoffTexte }));
    }

    // -- FOOTER -------------------------------------------------------------
    const footer = h('div', { class:'de-footer-bar' }, [
      h('span', { text:'Tes réponses sont enregistrées automatiquement sur cette tablette.' }),
      h('button', { type:'button', text:'Tout effacer', onclick: () => this._reset() })
    ]);
    wrap.appendChild(footer);

    root.appendChild(wrap);

    // Restaurer l'état mode correction si déjà actif
    if (this.store.get('__mode_correction')) this._toggleCorrection(true);

    this._updateProgression();
  };

  // -- Score pill ------------------------------------------------------------
  Devoir.prototype._buildScorePill = function() {
    return h('div', { class:'de-score-pill' }, [
      h('span', { class:'de-star', text:'★' }),
      h('div', null, [
        h('div', { class:'de-lbl', text:'Score' }),
        h('div', { class:'de-val' }, [
          this._scoreValueEl = h('em', { text:'0' }),
          document.createTextNode(' / ' + this.opts.total)
        ])
      ])
    ]);
  };

  // -- Hero ------------------------------------------------------------------
  Devoir.prototype._buildHero = function() {
    const hero = h('section', { class:'de-hero' });
    hero.appendChild(h('p', { class:'de-kicker', text:
      (this.opts.type === 'examen' ? 'Examen' : 'Devoir')
      + (this.opts.sujet ? ' — ' + this.opts.sujet : '')
      + ' · Niveau ' + this.opts.difficulte.toLowerCase() }));
    const titre = h('h1', null, [
      document.createTextNode((this.opts.type === 'examen' ? 'Examen' : 'Devoir') + ' de '),
      h('span', { class:'de-name', text: this.opts.eleve })
    ]);
    hero.appendChild(titre);
    hero.appendChild(h('p', { class:'de-sub', text: this.opts.matiere }));

    const meta = h('div', { class:'de-meta' });
    if (this.opts.niveau) {
      meta.appendChild(h('span', { html: this.opts.niveau }));
    }
    if (this.opts.cycle) {
      meta.appendChild(h('span', { class:'de-dot' }));
      meta.appendChild(h('span', { text: this.opts.cycle }));
    }
    meta.appendChild(h('span', { class:'de-dot' }));
    meta.appendChild(h('span', { text: this.exercices.length + ' exercices' }));
    if (this.opts.total > 0) {
      meta.appendChild(h('span', { class:'de-dot' }));
      meta.appendChild(h('span', { text: this.opts.total + ' points'
        + (this.bonusData ? ' + défi bonus' : '') }));
    }
    hero.appendChild(meta);

    if (this.opts.objectif) {
      hero.appendChild(h('p', { class:'de-objective' }, [
        h('b', { text:'Objectif — ' }),
        document.createTextNode(this.opts.objectif)
      ]));
    }
    return hero;
  };

  // -- Exercice --------------------------------------------------------------
  Devoir.prototype._renderExercice = function(ex) {
    const art = h('article', { class:'de-ex',
      'data-ex': ex.num, 'data-points': ex.points });

    art.appendChild(h('div', { class:'de-ex-head' }, [
      h('div', { class:'de-ex-num', text: ex.num }),
      h('h2', { class:'de-ex-title', text: ex.titre }),
      h('div', { class:'de-ex-points', text: ex.points + ' pts' })
    ]));

    ex.blocs.forEach(b => {
      const builder = Composants[b.type];
      if (!builder) {
        console.warn('Composant inconnu:', b.type);
        return;
      }
      const el = builder(b, this.store, ex, this);
      art.appendChild(el);
    });

    // Mode correction : input de score
    const scoreRow = this._buildExScore(ex);
    art.appendChild(scoreRow);

    // Mise à jour de la progression quand on modifie un input dans cet exercice
    art.addEventListener('input', () => this._updateProgression());
    art.addEventListener('click', () => {
      // petit délai pour que le state soit sauvegardé d'abord
      setTimeout(() => this._updateProgression(), 50);
    });

    return art;
  };

  // -- Score d'exercice (mode correction) ------------------------------------
  Devoir.prototype._buildExScore = function(ex) {
    const row = h('div', { class:'de-ex-score' });
    row.appendChild(h('span', { class:'de-ex-score-label', text:'Note du parent' }));

    const inp = h('input', { type:'number', min:'0', max: ex.points,
      step:'0.5', value: this.store.get('score_ex' + ex.num, '') });
    inp.addEventListener('input', () => {
      const v = inp.value === '' ? null : parseFloat(inp.value);
      if (v === null) this.store.del('score_ex' + ex.num);
      else {
        const clamped = Math.max(0, Math.min(ex.points, v));
        this.store.set('score_ex' + ex.num, clamped);
      }
      this._updateProgression();
    });
    this.scoreEls[ex.num] = inp;
    row.appendChild(inp);
    row.appendChild(h('span', { class:'de-over', text:' / ' + ex.points }));

    // boutons rapides
    const quick = h('div', { class:'de-quick' }, [
      h('button', { type:'button', text:'0', onclick: () => this._setScore(ex.num, 0) }),
      h('button', { type:'button', text:'½', onclick: () => this._setScore(ex.num, ex.points / 2) }),
      h('button', { type:'button', text: ex.points, onclick: () => this._setScore(ex.num, ex.points) })
    ]);
    row.appendChild(quick);
    return row;
  };

  Devoir.prototype._setScore = function(num, val) {
    this.store.set('score_ex' + num, val);
    if (this.scoreEls[num]) this.scoreEls[num].value = val;
    this._updateProgression();
  };

  // -- Bonus -----------------------------------------------------------------
  Devoir.prototype._renderBonus = function() {
    const aside = h('aside', { class:'de-bonus' });
    aside.appendChild(h('div', { class:'de-bonus-head' }, [
      h('div', { class:'de-bonus-title', text:'★ Défi bonus' }),
      h('div', { class:'de-bonus-points', text: this.bonusData.points || '+2 pts' })
    ]));
    aside.appendChild(h('p', { html: this.bonusData.texte }));
    const blanks = h('div', { class:'de-bonus-blanks' });
    this.bonusData.keys.forEach((k, i) => {
      const inp = h('input', { type:'text',
        placeholder:'mot ' + (i+1),
        value: this.store.get(k, '') });
      inp.addEventListener('input', () => this.store.set(k, inp.value));
      blanks.appendChild(inp);
    });
    aside.appendChild(blanks);
    return aside;
  };

  // -- Mode correction -------------------------------------------------------
  Devoir.prototype._toggleCorrection = function(forceOn) {
    this.modeCorrection = forceOn === true ? true : !this.modeCorrection;
    const root = document.querySelector('.de-app') || document.body;
    if (this.modeCorrection) {
      root.classList.add('de-mode-correction');
      this._correctBtn.classList.add('de-active');
      this._correctBtn.classList.remove('de-secondary');
      this._correctBtn.textContent = 'Vue de l\'élève';
      this.store.set('__mode_correction', true);
    } else {
      root.classList.remove('de-mode-correction');
      this._correctBtn.classList.remove('de-active');
      this._correctBtn.classList.add('de-secondary');
      this._correctBtn.textContent = 'Mode correction (parent)';
      this.store.del('__mode_correction');
    }
    this._updateProgression();
  };

  // -- Mise à jour de la progression / score --------------------------------
  Devoir.prototype._updateProgression = function() {
    if (!this._progressBar) return;
    this._progressBar.innerHTML = '';

    let scoreParents = 0;

    this.exercices.forEach(ex => {
      const fait = this._exerciceFait(ex);
      const dot = h('span', {
        class:'de-progress-dot' + (fait ? ' de-done' : ''),
        title:'Exercice ' + ex.num
      });
      this._progressBar.appendChild(dot);
      // Note : on n'utilise plus les exercices "complétés" pour calculer un
      // score. La barre de dots verts suffit pour la progression côté élève.

      const sp = this.store.get('score_ex' + ex.num);
      if (sp != null && sp !== '') {
        scoreParents += parseFloat(sp);
      }
    });

    // Affichage du pill SCORE :
    //  - en mode correction (parent) : somme des notes attribuées par le parent
    //  - en mode élève                : reste à 0 — seul le parent attribue les points.
    // La barre de dots verts indique déjà la progression de l'élève.
    if (this.modeCorrection) {
      this._scoreValueEl.textContent = (Math.round(scoreParents * 10) / 10).toString();
    } else {
      this._scoreValueEl.textContent = '0';
    }
  };

  // -- Heuristique "exercice complété" --------------------------------------
  // Un exercice est complété si TOUS ses blocs interactifs ont une valeur.
  // Les composants purement décoratifs (consigne, histoire, svg, horloges,
  // diagrammeBandes, diagrammePictogrammes, diagrammeLigneBrisee,
  // planCartesien sans points à placer, grilleAires, fractionDonnee, etc.)
  // ne sont pas comptés ici.
  Devoir.prototype._exerciceFait = function(ex) {
    const keys = collectKeys(ex);
    if (keys.length === 0 && !hasSpecialBlocs(ex)) return false;
    const baseOk = keys.every(k => {
      const v = this.store.get(k);
      if (v == null) return false;
      if (typeof v === 'string') return v.trim() !== '';
      if (Array.isArray(v))      return v.length > 0;
      if (typeof v === 'object') {
        // Les cas object (paires, tri) sont traités plus bas, on ne juge
        // pas ici. On considère « rempli » s'il existe.
        return true;
      }
      return true;
    });
    return baseOk
      && checkPaires(ex, this.store)
      && checkTri(ex, this.store)
      && checkOpColonne(ex, this.store)
      && checkGrilleDessin(ex, this.store);

    // -- helpers --
    function collectKeys(ex) {
      const ks = [];
      ex.blocs.forEach(b => {
        switch (b.type) {
          case 'texte':
            if (b.lignes === 1) ks.push(b.key);
            else for (let i = 0; i < b.lignes; i++) ks.push(b.key + '_' + i);
            break;
          case 'redaction':
          case 'ligneAvecFleche':
            ks.push(b.key); break;
          case 'phraseATrous':
            (b.keys || []).forEach(k => ks.push(k)); break;
          case 'choixInline':
            ks.push(b.key); break;
          case 'vraiFaux':
            (b.items || []).forEach(it => ks.push(it.key)); break;
          case 'toggleGrille':
            (b.items || []).forEach(it => ks.push(it.key)); break;
          case 'motsIntrus':
          case 'motsChips':
            ks.push(b.key); break;
          case 'fractionAColorier':
          case 'fractionCercle':
            ks.push(b.key); break;
          case 'fractionCollection':
            ks.push(b.key + '_num');
            ks.push(b.key + '_den');
            break;
          case 'symetrie':
            ks.push(b.key); break;
          case 'decomposition':
            (b.keys || []).forEach(k => ks.push(k)); break;
          case 'ligneNumerique':
            // Une ligne numérique peut être purement décorative (aucune
            // marque avec key). Ne collecte que les marques interactives.
            (b.marques || []).forEach(m => { if (m.key) ks.push(m.key); });
            break;
          case 'thermometres':
            // Idem : seuls les thermomètres avec key sont interactifs.
            (b.items || []).forEach(it => { if (it.key) ks.push(it.key); });
            break;
          case 'nombreMixte':
            if (b.entier) ks.push(b.key + '_ent');
            ks.push(b.key + '_num');
            ks.push(b.key + '_den');
            break;
          case 'argentQc':
            if (b.key) ks.push(b.key);
            break;
          case 'calendrier':
            if (b.mode === 'select' && b.key) ks.push(b.key);
            break;
          case 'ligneTemps':
            if (b.key && b.aOrdonner) {
              for (let i = 0; i < b.aOrdonner.length; i++) ks.push(b.key + '_' + i);
            }
            break;
          case 'schemaAnnote':
            (b.points || []).forEach(p => { if (p.key) ks.push(p.key); });
            break;
          case 'cycleVie':
            if (b.mode === 'ordre' && b.key && b.etapes) {
              for (let i = 0; i < b.etapes.length; i++) ks.push(b.key + '_' + i);
            }
            break;
          // grilleDessin : la complétion est jugée par checkGrilleDessin (au
          // moins un polygone fermé), pas par collectKeys.
          // 'operationColonne' et 'glisserDeposerCategories' sont traités
          // par checkOpColonne et checkTri (logique spéciale).
        }
      });
      return ks;
    }

    // Détecte si l'exercice contient au moins un bloc interactif
    // dont la complétion est jugée par un helper (et pas par collectKeys).
    function hasSpecialBlocs(ex) {
      return ex.blocs.some(b =>
        b.type === 'paires' ||
        b.type === 'glisserDeposerCategories' ||
        b.type === 'operationColonne' ||
        b.type === 'grilleDessin');
    }

    function checkPaires(ex, store) {
      for (const b of ex.blocs) {
        if (b.type === 'paires') {
          const s = store.get(b.key, { links: {} });
          const n = Object.keys(s.links || {}).length;
          if (n < (b.gauche || []).length) return false;
        }
      }
      return true;
    }

    function checkTri(ex, store) {
      // Tous les items doivent être placés dans une catégorie.
      for (const b of ex.blocs) {
        if (b.type === 'glisserDeposerCategories') {
          const placement = store.get(b.key, {});
          for (const item of (b.items || [])) {
            if (!placement[item]) return false;
          }
        }
      }
      return true;
    }

    function checkOpColonne(ex, store) {
      // Une opération posée est "complète" si au moins une case du résultat
      // est remplie. On est volontairement souple : un enfant peut écrire
      // un résultat à 3 chiffres dans une grille à 5 cases.
      for (const b of ex.blocs) {
        if (b.type === 'operationColonne') {
          // Le nombre de cases dépend du rendu (calculé dans le builder à
          // partir de la longueur des opérandes). On scanne jusqu'à 12.
          let auMoinsUne = false;
          for (let i = 0; i < 12; i++) {
            const v = store.get(b.key + '_' + i);
            if (v != null && String(v).trim() !== '') { auMoinsUne = true; break; }
          }
          if (!auMoinsUne) return false;
        }
      }
      return true;
    }

    function checkGrilleDessin(ex, store) {
      // Une grille de dessin est considérée "complète" si TOUS les enclos
      // déclarés ont leur polygone fermé. Volontairement strict : c'est ce
      // qu'on attend dans une situation-problème (chaque enclos est tracé).
      for (const b of ex.blocs) {
        if (b.type === 'grilleDessin') {
          const state = store.get(b.key, null);
          if (!state || !state.polygones) return false;
          for (const e of (b.enclos || [])) {
            const poly = state.polygones[e.id];
            if (!poly || !poly.ferme) return false;
          }
        }
      }
      return true;
    }
  };

  // -- Reset -----------------------------------------------------------------
  Devoir.prototype._reset = function() {
    if (confirm('Effacer toutes les réponses ? (cette action ne peut pas être annulée)')) {
      this.store.reset();
      location.reload();
    }
  };

  // ========================================================================
  // API PUBLIQUE
  // ========================================================================
  const Devoir_API = {
    creer(opts) { return new Devoir(opts); },
    version: '1.0.0'
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Devoir_API;
  global.Devoir = Devoir_API;

})(typeof window !== 'undefined' ? window : this);

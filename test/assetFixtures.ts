/**
 * Fixtures Asset Store + exemples (ticket #18). Aucun réseau en test :
 * la source injectée réplique le CDN public à petite échelle, d'après
 * `docs/research/gdevelop-mcp-assets-research.md` §2-3 et §7.
 */

import type {
  AssetDetails,
  AssetPackSummary,
  AssetShortHeader,
  AssetSource,
  ExampleDetails,
  ExampleShortHeader,
} from '../src/assetSource.js';

export const FIXTURE_PACKS = {
  starterPacks: [
    {
      name: 'Player Avatar',
      tag: 'player avatar',
      thumbnailUrl: 'https://asset-resources.gdevelop.io/public-resources/Player/avatar.png',
      assetsCount: 1,
      categories: ['prefab', 'interface'],
      authors: [{ name: 'GDevelop', website: 'https://gdevelop.io' }],
      licenses: [{ name: 'CC0 (public domain)', website: 'https://creativecommons.org/share-your-work/public-domain/cc0/' }],
    },
    {
      name: 'Collectable items',
      tag: 'collectable',
      thumbnailUrl: 'https://asset-resources.gdevelop.io/public-resources/Collectable/thumb.png',
      assetsCount: 3,
      categories: ['prefab'],
      authors: [{ name: 'GentleCatStudio', website: '' }],
      licenses: [{ name: 'CC0 (public domain)', website: '' }],
    },
  ],
};

export const FIXTURE_HEADERS = [
  {
    id: '0d22d5d4aa7a4b3c9d8e1f2a3b4c5d6e',
    name: 'Bronze Coin',
    shortDescription: 'A shiny collectable coin',
    previewImageUrls: [
      'https://asset-resources.gdevelop.io/public-resources/16x16 Pixel art RPG Items/Collectable items/8e90abcd_Bronze Coin.png',
    ],
    tags: ['16x16 pixel art rpg items', 'side view', 'pixel art', 'collectable'],
    license: 'CC0 (public domain)',
    objectType: 'sprite',
    animationsCount: 1,
    maxFramesCount: 1,
    width: 16,
    height: 16,
    dominantColors: [1579048],
    assetPackId: 'collectable',
  },
  {
    id: 'fd002c68aa7a4b3c9d8e1f2a3b4c5d6f',
    name: 'Bronze Shield',
    shortDescription: 'A sturdy bronze shield',
    previewImageUrls: [
      'https://asset-resources.gdevelop.io/public-resources/16x16 Pixel art RPG Items/Armor/9f01abcd_Bronze Shield.png',
    ],
    tags: ['16x16 pixel art rpg items', 'side view', 'pixel art', 'armor'],
    license: 'CC0 (public domain)',
    objectType: 'sprite',
    animationsCount: 1,
    maxFramesCount: 1,
    width: 16,
    height: 16,
    dominantColors: [1579048],
    assetPackId: 'collectable',
  },
  {
    id: 'aa11bb22cc33dd44ee55ff0011223344',
    name: 'Hero Avatar',
    shortDescription: 'Player hero avatar',
    previewImageUrls: ['https://asset-resources.gdevelop.io/public-resources/Player/Avatar/ab12_Hero.png'],
    tags: ['player avatar', 'prefab', 'collectable'],
    license: 'CC0 (public domain)',
    objectType: 'sprite',
    animationsCount: 1,
    maxFramesCount: 1,
    width: 32,
    height: 32,
    dominantColors: [123456],
    assetPackId: 'collectable',
  },
];

export const FIXTURE_COIN_DETAILS = {
  id: '0d22d5d4aa7a4b3c9d8e1f2a3b4c5d6e',
  name: 'Bronze Coin',
  authors: ['GentleCatStudio'],
  license: 'CC0 (public domain)',
  shortDescription: 'A shiny collectable coin',
  description: 'Collectable bronze coin for platformers.',
  tags: ['16x16 pixel art rpg items', 'side view', 'pixel art', 'collectable'],
  objectAssets: [
    {
      object: {
        type: 'Sprite',
        name: 'Bronze Coin',
        assetStoreId: '0d22d5d4aa7a4b3c9d8e1f2a3b4c5d6e',
        variables: [],
        effects: [],
        behaviors: [],
        animations: [],
      },
      customization: [],
      requiredExtensions: [],
      resources: [
        {
          alwaysLoaded: false,
          file: 'https://asset-resources.gdevelop.io/public-resources/16x16 Pixel art RPG Items/Collectable items/8e90abcd_Bronze Coin.png',
          kind: 'image',
          metadata: '',
          name: 'Bronze Coin.png',
          smoothed: true,
          userAdded: false,
          origin: {
            name: 'gdevelop-asset-store',
            identifier:
              'https://asset-resources.gdevelop.io/public-resources/16x16 Pixel art RPG Items/Collectable items/8e90abcd_Bronze Coin.png',
          },
        },
      ],
    },
  ],
  gdevelopVersion: '5.0.0-beta100',
  version: '1.0.0',
  animationsCount: 1,
  maxFramesCount: 1,
  objectType: 'sprite',
  previewImageUrls: [
    'https://asset-resources.gdevelop.io/public-resources/16x16 Pixel art RPG Items/Collectable items/8e90abcd_Bronze Coin.png',
  ],
  dominantColors: [1579048],
  width: 16,
  height: 16,
};

export const FIXTURE_SHIELD_DETAILS = {
  id: 'fd002c68aa7a4b3c9d8e1f2a3b4c5d6f',
  name: 'Bronze Shield',
  authors: ['GentleCatStudio'],
  license: 'CC0 (public domain)',
  shortDescription: 'A sturdy bronze shield',
  description: 'Bronze shield armor.',
  tags: ['16x16 pixel art rpg items', 'side view', 'pixel art', 'armor'],
  objectAssets: [
    {
      object: { type: 'Sprite', name: 'Bronze Shield', variables: [], behaviors: [], animations: [] },
      customization: [],
      requiredExtensions: [],
      resources: [
        {
          alwaysLoaded: false,
          file: 'https://asset-resources.gdevelop.io/public-resources/16x16 Pixel art RPG Items/Armor/9f01abcd_Bronze Shield.png',
          kind: 'image',
          metadata: '',
          name: 'Bronze Shield.png',
          smoothed: true,
          userAdded: false,
          origin: {
            name: 'gdevelop-asset-store',
            identifier:
              'https://asset-resources.gdevelop.io/public-resources/16x16 Pixel art RPG Items/Armor/9f01abcd_Bronze Shield.png',
          },
        },
      ],
    },
  ],
  gdevelopVersion: '5.0.0-beta100',
  version: '1.0.0',
  animationsCount: 1,
  maxFramesCount: 1,
  objectType: 'sprite',
  previewImageUrls: [
    'https://asset-resources.gdevelop.io/public-resources/16x16 Pixel art RPG Items/Armor/9f01abcd_Bronze Shield.png',
  ],
  dominantColors: [1579048],
  width: 16,
  height: 16,
};

export const FIXTURE_HERO_DETAILS = {
  id: 'aa11bb22cc33dd44ee55ff0011223344',
  name: 'Hero Avatar',
  authors: ['GDevelop'],
  license: 'CC0 (public domain)',
  shortDescription: 'Player hero avatar',
  description: 'Hero.',
  tags: ['player avatar', 'prefab'],
  objectAssets: [
    {
      object: { type: 'Sprite', name: 'Hero', variables: [], behaviors: [], animations: [] },
      customization: [],
      requiredExtensions: [],
      resources: [
        {
          alwaysLoaded: false,
          file: 'https://asset-resources.gdevelop.io/public-resources/Player/Avatar/ab12_Hero.png',
          kind: 'image',
          metadata: '',
          name: 'Hero.png',
          smoothed: true,
          userAdded: false,
          origin: { name: 'gdevelop-asset-store', identifier: 'https://asset-resources.gdevelop.io/public-resources/Player/Avatar/ab12_Hero.png' },
        },
      ],
    },
  ],
  gdevelopVersion: '5.0.0-beta100',
  version: '1.0.0',
  animationsCount: 1,
  maxFramesCount: 1,
  objectType: 'sprite',
  previewImageUrls: ['https://asset-resources.gdevelop.io/public-resources/Player/Avatar/ab12_Hero.png'],
  dominantColors: [123456],
  width: 32,
  height: 32,
};

/** Asset synthétique à extension requise (preuve du refus, recherche §7 Q2). */
export const FIXTURE_SPINE_DETAILS = {
  ...FIXTURE_COIN_DETAILS,
  id: 'bb22cc33dd44ee55ff00112233445566',
  name: 'Spine Hero',
  objectAssets: [
    {
      ...FIXTURE_COIN_DETAILS.objectAssets[0],
      object: { type: 'SpineObject::Spine', name: 'Spine Hero', variables: [], behaviors: [], animations: [] },
      requiredExtensions: [{ extensionName: 'Spine', extensionVersion: '1.0.0' }],
    },
  ],
};

/** Asset privé/premium (détection isPrivateAsset, recherche §4). */
export const FIXTURE_PRIVATE_DETAILS = {
  ...FIXTURE_COIN_DETAILS,
  id: 'cc33dd44ee55ff001122334455667788',
  name: 'Private Sword',
  previewImageUrls: ['https://private-assets.gdevelop.io/abcdef/Private Sword.png'],
};

/** Asset à variantes custom (hors-scope MVP, recherche §7 Q3). */
export const FIXTURE_VARIANT_DETAILS = {
  ...FIXTURE_COIN_DETAILS,
  id: 'dd44ee55ff0011223344556677889900',
  name: 'Variant Chest',
  objectAssets: [
    {
      ...FIXTURE_COIN_DETAILS.objectAssets[0],
      variants: [{ objectType: 'MyExt::Chest', variant: {} }],
    },
  ],
};

export const FIXTURE_FILTERS = {
  allTags: ['16x16 pixel art rpg items', 'side view', 'pixel art', 'armor', 'collectable', 'player avatar', 'prefab'],
  defaultTags: ['pixel art', 'prefab'],
  tagsTree: [],
};

export const FIXTURE_EXAMPLE_HEADERS = [
  {
    id: 'd260466baa7a4b3c9d8e1f2a3b4c5d60',
    slug: 'platformer',
    name: 'Platformer',
    shortDescription: 'Simple platformer starter',
    description: 'Starter platformer.',
    license: 'MIT',
    tags: ['platformer', 'game', 'simple', 'Platform behavior', 'Sprite'],
    previewImageUrls: ['https://resources.gdevelop-app.com/examples/platformer/preview.png'],
    difficultyLevel: 'simple',
    codeSizeLevel: 'small',
    gdevelopVersion: '5.6.280',
  },
];

export const FIXTURE_EXAMPLE_DETAILS = {
  id: 'd260466baa7a4b3c9d8e1f2a3b4c5d60',
  slug: 'platformer',
  name: 'Platformer',
  shortDescription: 'Simple platformer starter',
  description: 'Starter platformer.',
  license: 'MIT',
  tags: ['platformer', 'game'],
  previewImageUrls: ['https://resources.gdevelop-app.com/examples/platformer/preview.png'],
  difficultyLevel: 'simple',
  codeSizeLevel: 'small',
  gdevelopVersion: '5.6.280',
  authors: ['GDevelop'],
  projectFileUrl: 'https://resources.gdevelop-app.com/examples/platformer/platformer.json',
  usedExtensions: [],
  eventsBasedExtensions: [],
};

export const FIXTURE_EXAMPLE_PROJECT = {
  projectFile: '',
  properties: { firstLayout: 'Scene', windowWidth: 800, windowHeight: 600 },
  resources: { resources: [] },
  layouts: [{ name: 'Scene', layers: [{ name: '' }], objects: [], instances: [], variables: [], objectsGroups: [], events: [] }],
  objects: [],
  variables: [],
  objectsGroups: [],
  eventsBasedObjects: [],
  eventsFunctionsExtensions: [],
  folderProject: false,
};

/** Binaire factice (1 PNG minimal) pour downloadBinary. */
export const FIXTURE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface FixtureAssetSourceOptions {
  now?: number;
}

/**
 * Source Asset Store en mémoire : déterministe, sans réseau, avec compteurs
 * (calquée sur makeFixtureSource du catalogue).
 */
export function makeFixtureAssetSource(): AssetSource & {
  state: {
    packLoads: number;
    headerLoads: number;
    detailLoads: number;
    exampleLoads: number;
    exampleDetailLoads: number;
    binaryLoads: number;
    projectLoads: number;
  };
} {
  const state = {
    packLoads: 0,
    headerLoads: 0,
    detailLoads: 0,
    exampleLoads: 0,
    exampleDetailLoads: 0,
    binaryLoads: 0,
    projectLoads: 0,
  };
  const detailsById: Record<string, AssetDetails> = {
    [FIXTURE_COIN_DETAILS.id]: FIXTURE_COIN_DETAILS as unknown as AssetDetails,
    [FIXTURE_SHIELD_DETAILS.id]: FIXTURE_SHIELD_DETAILS as unknown as AssetDetails,
    [FIXTURE_HERO_DETAILS.id]: FIXTURE_HERO_DETAILS as unknown as AssetDetails,
    [FIXTURE_SPINE_DETAILS.id]: FIXTURE_SPINE_DETAILS as unknown as AssetDetails,
    [FIXTURE_PRIVATE_DETAILS.id]: FIXTURE_PRIVATE_DETAILS as unknown as AssetDetails,
    [FIXTURE_VARIANT_DETAILS.id]: FIXTURE_VARIANT_DETAILS as unknown as AssetDetails,
  };
  return {
    state,
    async listPacks(): Promise<AssetPackSummary[]> {
      state.packLoads += 1;
      return structuredClone(FIXTURE_PACKS.starterPacks) as unknown as AssetPackSummary[];
    },
    async listHeaders(): Promise<AssetShortHeader[]> {
      state.headerLoads += 1;
      return structuredClone(FIXTURE_HEADERS) as unknown as AssetShortHeader[];
    },
    async listFilters() {
      return structuredClone(FIXTURE_FILTERS);
    },
    async getDetails(id: string): Promise<AssetDetails> {
      state.detailLoads += 1;
      const found = detailsById[id];
      if (!found) {
        const error = new Error(`Asset CDN error (404) for https://resources.gdevelop-app.com/assets-database/assets/${id}.json`);
        (error as unknown as { status: number }).status = 404;
        throw error;
      }
      return structuredClone(found);
    },
    async listExampleHeaders(): Promise<ExampleShortHeader[]> {
      state.exampleLoads += 1;
      return structuredClone(FIXTURE_EXAMPLE_HEADERS) as unknown as ExampleShortHeader[];
    },
    async listExampleFilters() {
      return { allTags: [], tagsTree: [], defaultTags: ['Platform behavior', 'Sprite', 'Variables'] };
    },
    async getExample(idOrSlug: string): Promise<ExampleDetails> {
      state.exampleDetailLoads += 1;
      const match =
        FIXTURE_EXAMPLE_HEADERS.find((h) => h.id === idOrSlug || h.slug === idOrSlug) ?? null;
      if (!match) {
        throw new Error(`Couldn't retrieve the example.`);
      }
      return structuredClone({ ...FIXTURE_EXAMPLE_DETAILS, id: match.id, slug: match.slug }) as unknown as ExampleDetails;
    },
    async fetchProjectJson(url: string) {
      state.projectLoads += 1;
      if (url === FIXTURE_EXAMPLE_DETAILS.projectFileUrl) return structuredClone(FIXTURE_EXAMPLE_PROJECT);
      throw new Error(`Asset CDN error (404) for ${url}`);
    },
    async downloadBinary(_url: string) {
      state.binaryLoads += 1;
      return FIXTURE_PNG;
    },
  };
}

export type FixtureAssetSource = ReturnType<typeof makeFixtureAssetSource>;

import * as migration_20260930_101858_initial from './20260930_101858_initial';
import * as migration_20260930_105005_manifest_outbox from './20260930_105005_manifest_outbox';
import * as migration_20260930_112419_search_index from './20260930_112419_search_index';

export const migrations = [
  {
    up: migration_20260930_101858_initial.up,
    down: migration_20260930_101858_initial.down,
    name: '20260930_101858_initial',
  },
  {
    up: migration_20260930_105005_manifest_outbox.up,
    down: migration_20260930_105005_manifest_outbox.down,
    name: '20260930_105005_manifest_outbox',
  },
  {
    up: migration_20260930_112419_search_index.up,
    down: migration_20260930_112419_search_index.down,
    name: '20260930_112419_search_index'
  },
];

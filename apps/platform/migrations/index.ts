import * as migration_20260930_101858_initial from './20260930_101858_initial';
import * as migration_20260930_105005_manifest_outbox from './20260930_105005_manifest_outbox';
import * as migration_20260930_112419_search_index from './20260930_112419_search_index';
import * as migration_20260930_181108_public_media_storage from './20260930_181108_public_media_storage';
import * as migration_20260930_183921 from './20260930_183921';
import * as migration_20261001_081531_course_manifest_states from './20261001_081531_course_manifest_states';

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
    name: '20260930_112419_search_index',
  },
  {
    up: migration_20260930_181108_public_media_storage.up,
    down: migration_20260930_181108_public_media_storage.down,
    name: '20260930_181108_public_media_storage',
  },
  {
    up: migration_20260930_183921.up,
    down: migration_20260930_183921.down,
    name: '20260930_183921',
  },
  {
    up: migration_20261001_081531_course_manifest_states.up,
    down: migration_20261001_081531_course_manifest_states.down,
    name: '20261001_081531_course_manifest_states'
  },
];

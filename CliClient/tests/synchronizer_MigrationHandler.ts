import LockHandler from 'lib/services/synchronizer/LockHandler';
import MigrationHandler from 'lib/services/synchronizer/MigrationHandler';

require('app-module-path').addPath(__dirname);

const { asyncTest, fileApi, synchronizer, setupDatabaseAndSynchronizer, switchClient, expectThrow, expectNotThrow } = require('test-utils.js');
const Setting = require('lib/models/Setting');
const Folder = require('lib/models/Folder');
const Note = require('lib/models/Note');
const Tag = require('lib/models/Tag');
const Resource = require('lib/models/Resource');
const markdownUtils = require('lib/markdownUtils');
const { shim } = require('lib/shim');

let lockHandler_:LockHandler = null;
let migrationHandler_:MigrationHandler = null;

function lockHandler():LockHandler {
	if (lockHandler_) return lockHandler_;
	lockHandler_ = new LockHandler(fileApi());
	return lockHandler_;
}

function migrationHandler(clientId:string = 'abcd'):MigrationHandler {
	if (migrationHandler_) return migrationHandler_;
	migrationHandler_ = new MigrationHandler(fileApi(), lockHandler(), 'desktop', clientId);
	return migrationHandler_;
}

const testData:any = {
	folder1: {
		subFolder1: {},
		subFolder2: {
			note1: {
				resource: true,
				tags: ['tag1'],
			},
			note2: {},
		},
		note3: {
			tags: ['tag1', 'tag2'],
		},
		note4: {
			tags: ['tag2'],
		},
	},
	folder2: {},
	folder3: {
		note5: {
			resource: true,
			tags: ['tag2'],
		},
	},
};

async function createTestData(data:any) {
	async function recurseStruct(s:any, parentId:string = '') {
		for (const n in s) {
			if (n.toLowerCase().includes('folder')) {
				const folder = await Folder.save({ title: n, parent_id: parentId });
				await recurseStruct(s[n], folder.id);
			} else {
				const note = await Note.save({ title: n, parent_id: parentId });
				if (s[n].resource) {
					await shim.attachFileToNote(note, `${__dirname}/../tests/support/photo.jpg`);
				}

				if (s[n].tags) {
					for (const tagTitle of s[n].tags) {
						await Tag.addNoteTagByTitle(note.id, tagTitle);
					}
				}
			}
		}
	}

	await recurseStruct(data);
}

async function checkTestData(data:any) {
	async function recurseCheck(s:any) {
		for (const n in s) {
			const obj = s[n];

			if (n.toLowerCase().includes('folder')) {
				const folder = await Folder.loadByTitle(n);
				expect(!!folder).toBe(true, `Folder: ${n}`);
				await recurseCheck(obj);
			} else {
				const note = await Note.loadByTitle(n);
				expect(!!note).toBe(true, `Note: ${n}`);

				const parent = await Folder.load(note.parent_id);
				expect(!!parent).toBe(true, `Note parent: ${n}`);

				if (obj.resource) {
					const urls = markdownUtils.extractImageUrls(note.body);
					const resourceId = urls[0].substr(2);
					const resource = await Resource.load(resourceId);
					expect(!!resource).toBe(true, `Note resource: ${n}`);
				}

				if (obj.tags) {
					for (const tagTitle of obj.tags) {
						const tag = await Tag.loadByTitle(tagTitle);
						expect(!!tag).toBe(true, `Tag: ${tagTitle}`);
						expect(await Tag.hasNote(tag.id, note.id)).toBe(true);
					}
				}
			}
		}
	}

	await recurseCheck(data);
}

interface MigrationTests {
	[key:string]: Function;
}

const migrationTests:MigrationTests = {
	2: async function() {
		const items = (await fileApi().list()).items;
		expect(items.filter((i:any) => i.path === 'locks' && i.isDir).length).toBe(1);
		expect(items.filter((i:any) => i.path === 'temp' && i.isDir).length).toBe(1);
		expect(items.filter((i:any) => i.path === 'info.json' && !i.isDir).length).toBe(1);
	},
};

describe('synchronizer_MigrationHandler', function() {

	beforeEach(async (done:Function) => {
		lockHandler_ = null;
		migrationHandler_ = null;
		await setupDatabaseAndSynchronizer(1);
		await setupDatabaseAndSynchronizer(2);
		await switchClient(1);
		done();
	});

	it('should not allow syncing if the sync versions are not the same', asyncTest(async () => {
		Setting.setConstant('syncVersion', 1);

		await synchronizer().start();

		Setting.setConstant('syncVersion', 2);

		expectThrow(async () => await migrationHandler().checkCanSync(), 'outdatedSyncTarget');

		await migrationHandler().upgrade(2);

		expectNotThrow(async () => await migrationHandler().checkCanSync());

		Setting.setConstant('syncVersion', 1);

		expectThrow(async () => await migrationHandler().checkCanSync(), 'outdatedClient');
	}));

	// Create a helper function that create notes, folders, resources and tags
	// Sync with previous sync format
	// Upgrade
	// Sync with new sync format
	// With encryption and without
	// => Check we got back the same notes, folders and tags

	for (const migrationVersionString in migrationTests) {
		const migrationVersion = Number(migrationVersionString);

		it(`should migrate (${migrationVersion})`, asyncTest(async () => {
			// First create some test data that will be used to validate
			// that the migration didn't alter any data.
			await createTestData(testData);

			// Setup the client and sync target as being the previous syncVersion
			Setting.setConstant('syncVersion', migrationVersion - 1);
			await synchronizer().start();

			// Verify that the sync target is set at the previous version
			const info = await migrationHandler().fetchSyncTargetInfo();
			expect(info.version).toBe(migrationVersion - 1);

			// Now, migration to the new version
			await migrationHandler().upgrade(migrationVersion);

			// Verify that it has been upgraded
			const newInfo = await migrationHandler().fetchSyncTargetInfo();
			expect(newInfo.version).toBe(migrationVersion);
			await migrationTests[migrationVersion]();
			Setting.setConstant('syncVersion', migrationVersion);

			// Now sync with that upgraded target
			await synchronizer().start();

			// Check that the data has not been altered
			await checkTestData(testData);

			// Check what happens if we switch to a different client and sync
			await switchClient(2);
			Setting.setConstant('syncVersion', migrationVersion);
			await synchronizer().start();
			await checkTestData(testData);
		}));
	}

});

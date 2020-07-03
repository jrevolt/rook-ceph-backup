import {list, ListOptions, search, SearchOptions} from "./commands";

test('search', async () => {
  await search(<SearchOptions>{})
})
test('list', async () => {
  await list(<ListOptions>{})
})

import {Main} from "./main";

test('search', async () => {
  await Main.instance.run(['search', 'test'])
})

test('ls', async () => {
  await Main.instance.run(['ls'])
})

test('snapshot', async () => {
  await Main.instance.run(['snapshot'])
})

test('backup', async () => {
  await Main.instance.run(['backup'])
})

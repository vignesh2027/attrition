import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {visionTool} from '@sanity/vision'
import {contextPlugin} from '@sanity/context/studio'
import {schemaTypes} from './schemaTypes'
import {structure} from './structure'

export default defineConfig({
  name: 'default',
  title: 'Attrition',
  projectId: 'y9raau23',
  dataset: 'production',
  plugins: [structureTool({structure}), visionTool(), contextPlugin()],
  schema: {types: schemaTypes},
})

import {createElement} from 'react'
import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {visionTool} from '@sanity/vision'
import {contextPlugin} from '@sanity/context/studio'
import {schemaTypes} from './schemaTypes'
import {structure} from './structure'

export default defineConfig({
  name: 'default',
  title: 'Attrition',
  icon: () => createElement('img', {src: 'https://attrition-otel.vercel.app/mark.svg', alt: '', style: {width: '100%', height: '100%', borderRadius: 6}}),
  projectId: 'y9raau23',
  dataset: 'production',
  plugins: [structureTool({structure}), visionTool(), contextPlugin()],
  schema: {types: schemaTypes},
})

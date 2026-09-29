import type {NextConfig} from 'next'

const config: NextConfig = {
  outputFileTracingIncludes: {'/': ['./samples/**']},
}

export default config

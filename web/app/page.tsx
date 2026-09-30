import {Attrition} from '@/components/Attrition'
import {samples} from '@/lib/samples'

export default function Page() {
  return <Attrition samples={samples()} />
}

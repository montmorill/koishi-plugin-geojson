import antfu from '@antfu/eslint-config'

export default antfu({
  rules: {
    'ts/no-namespace': 'off',
    'ts/no-redeclare': 'off',
  },
})

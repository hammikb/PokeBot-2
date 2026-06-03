import { describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import { downloadProxies, parseProxyList } from '../../../src/main/proxies/ProxyImport.js'

vi.mock('axios')

describe('parseProxyList', () => {
  it('normalizes host port username password lines', () => {
    expect(parseProxyList('1.2.3.4:8080:user:pass\n5.6.7.8:9000:user2:pass2')).toEqual([
      '1.2.3.4:8080:user:pass',
      '5.6.7.8:9000:user2:pass2'
    ])
  })

  it('normalizes username password at host port lines', () => {
    expect(parseProxyList('http://user:pass@1.2.3.4:8080')).toEqual(['1.2.3.4:8080:user:pass'])
  })

  it('skips empty comments and unsupported lines', () => {
    expect(parseProxyList('# comment\n\nbad-line\n1.2.3.4:8080:user:pass')).toEqual([
      '1.2.3.4:8080:user:pass'
    ])
  })
})

describe('downloadProxies', () => {
  it('downloads and parses proxies from a URL', async () => {
    axios.get.mockResolvedValue({
      data: '1.2.3.4:8080:user:pass\n5.6.7.8:9000:user2:pass2'
    })

    const result = await downloadProxies('https://proxy.example/download')

    expect(axios.get).toHaveBeenCalledWith('https://proxy.example/download', {
      responseType: 'text',
      timeout: 30000
    })
    expect(result).toEqual({
      proxies: ['1.2.3.4:8080:user:pass', '5.6.7.8:9000:user2:pass2'],
      count: 2
    })
  })
})

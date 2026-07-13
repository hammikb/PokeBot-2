import { useState } from 'react'
import { useAppStore } from '../store/appStore'

export default function Login() {
  const { signIn, signUp, authError, clearAuthError } = useAppStore()
  const [mode, setMode] = useState('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    try {
      if (mode === 'sign-in') await signIn(email, password, rememberMe)
      else await signUp(email, password, rememberMe)
    } catch {
      // authError is already set in the store by signIn/signUp
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-[#0f0f0f] text-gray-100 font-mono text-base">
      <form
        onSubmit={handleSubmit}
        className="w-80 space-y-4 bg-[#141414] border border-gray-800 rounded p-6"
      >
        <div className="text-red-500 font-bold tracking-widest uppercase text-lg text-center mb-2">
          PB2
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setMode('sign-in')
              clearAuthError()
            }}
            className={`flex-1 px-3 py-1.5 rounded uppercase tracking-wider text-sm font-bold border ${
              mode === 'sign-in'
                ? 'bg-red-600 border-red-500 text-white'
                : 'bg-[#111] border-gray-700 text-gray-400'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('sign-up')
              clearAuthError()
            }}
            className={`flex-1 px-3 py-1.5 rounded uppercase tracking-wider text-sm font-bold border ${
              mode === 'sign-up'
                ? 'bg-red-600 border-red-500 text-white'
                : 'bg-[#111] border-gray-700 text-gray-400'
            }`}
          >
            Sign Up
          </button>
        </div>

        <div>
          <label className="text-gray-500 uppercase tracking-wider text-sm block mb-1.5">
            Email
          </label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-[#111] border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:border-red-500 outline-none transition-colors"
          />
        </div>

        <div>
          <label className="text-gray-500 uppercase tracking-wider text-sm block mb-1.5">
            Password
          </label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-[#111] border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:border-red-500 outline-none transition-colors"
          />
        </div>

        <label className="flex items-center gap-2 text-gray-400 text-sm select-none">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
            className="accent-red-600"
          />
          Stay signed in
        </label>

        {authError && <div className="text-red-500 text-sm">{authError}</div>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full px-3 py-2 rounded uppercase tracking-wider text-sm font-bold bg-red-600 border border-red-500 text-white disabled:opacity-50"
        >
          {submitting ? 'Please wait...' : mode === 'sign-in' ? 'Sign In' : 'Sign Up'}
        </button>
      </form>
    </div>
  )
}

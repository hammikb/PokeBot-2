import { useState, useEffect } from 'react'
import { useAppStore } from '../store/appStore'

export default function ShippingAddresses() {
  const {
    shippingAddresses,
    loadShippingAddresses,
    createShippingAddress,
    deleteShippingAddress,
    setDefaultShippingAddress
  } = useAppStore()

  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    firstName: '',
    lastName: '',
    address1: '',
    address2: '',
    city: '',
    state: '',
    zip: '',
    phone: '',
    isDefault: false
  })

  useEffect(() => {
    loadShippingAddresses()
  }, [loadShippingAddresses])

  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      await createShippingAddress(formData)
      setShowForm(false)
      setFormData({
        name: '',
        firstName: '',
        lastName: '',
        address1: '',
        address2: '',
        city: '',
        state: '',
        zip: '',
        phone: '',
        isDefault: false
      })
    } catch (err) {
      alert(`Error: ${err.message}`)
    }
  }

  const handleDelete = async (id) => {
    if (confirm('Delete this address?')) {
      await deleteShippingAddress(id)
    }
  }

  const handleSetDefault = async (id) => {
    await setDefaultShippingAddress(id)
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Shipping Addresses</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          {showForm ? 'Cancel' : 'Add Address'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-gray-800 p-6 rounded-lg space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="Home"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">First Name</label>
              <input
                type="text"
                value={formData.firstName}
                onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="John"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Last Name</label>
              <input
                type="text"
                value={formData.lastName}
                onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="Doe"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Address Line 1</label>
              <input
                type="text"
                value={formData.address1}
                onChange={(e) => setFormData({ ...formData, address1: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="123 Main St"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Address Line 2</label>
              <input
                type="text"
                value={formData.address2}
                onChange={(e) => setFormData({ ...formData, address2: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="Apt 4B"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">City</label>
              <input
                type="text"
                value={formData.city}
                onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="Los Angeles"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">State</label>
              <input
                type="text"
                value={formData.state}
                onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="CA"
                maxLength="2"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">ZIP</label>
              <input
                type="text"
                value={formData.zip}
                onChange={(e) => setFormData({ ...formData, zip: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="90210"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Phone</label>
              <input
                type="text"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="555-123-4567"
              />
            </div>
            <div className="flex items-center pt-6">
              <input
                type="checkbox"
                checked={formData.isDefault}
                onChange={(e) => setFormData({ ...formData, isDefault: e.target.checked })}
                className="mr-2"
                id="isDefault"
              />
              <label htmlFor="isDefault" className="text-sm font-medium cursor-pointer">
                Set as default address
              </label>
            </div>
          </div>
          <button
            type="submit"
            className="w-full px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
          >
            Save Address
          </button>
        </form>
      )}

      <div className="grid gap-4">
        {shippingAddresses.map((address) => (
          <div key={address.id} className="bg-gray-800 p-4 rounded-lg">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-bold text-lg">
                  {address.name}
                  {address.is_default && (
                    <span className="ml-2 text-xs bg-blue-600 px-2 py-1 rounded">Default</span>
                  )}
                </h3>
                <p className="text-sm mt-1">
                  {address.first_name} {address.last_name}
                </p>
                <p className="text-sm text-gray-400">{address.address1}</p>
                {address.address2 && <p className="text-sm text-gray-400">{address.address2}</p>}
                <p className="text-sm text-gray-400">
                  {address.city}, {address.state} {address.zip}
                </p>
                {address.phone && <p className="text-sm text-gray-400">{address.phone}</p>}
              </div>
              <div className="flex gap-2">
                {!address.is_default && (
                  <button
                    onClick={() => handleSetDefault(address.id)}
                    className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
                  >
                    Set Default
                  </button>
                )}
                <button
                  onClick={() => handleDelete(address.id)}
                  className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 text-sm"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
        {shippingAddresses.length === 0 && !showForm && (
          <div className="text-center py-12">
            <p className="text-gray-400 mb-4">No shipping addresses yet.</p>
            <p className="text-sm text-gray-500">
              Add a shipping address to use across multiple accounts
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

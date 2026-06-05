import { useState, useEffect } from 'react'
import { useAppStore } from '../store/appStore'

export default function PaymentMethods() {
  const { paymentMethods, loadPaymentMethods, createPaymentMethod, deletePaymentMethod } =
    useAppStore()
  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    cardNumber: '',
    expiryMonth: '',
    expiryYear: '',
    cvv: '',
    billingAddress1: '',
    billingAddress2: '',
    billingCity: '',
    billingState: '',
    billingZip: '',
    billingPhone: ''
  })

  useEffect(() => {
    loadPaymentMethods()
  }, [loadPaymentMethods])

  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      await createPaymentMethod(formData)
      setShowForm(false)
      setFormData({
        name: '',
        cardNumber: '',
        expiryMonth: '',
        expiryYear: '',
        cvv: '',
        billingAddress1: '',
        billingAddress2: '',
        billingCity: '',
        billingState: '',
        billingZip: '',
        billingPhone: ''
      })
    } catch (err) {
      alert(`Error: ${err.message}`)
    }
  }

  const handleDelete = async (id) => {
    if (confirm('Delete this payment method?')) {
      await deletePaymentMethod(id)
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Payment Methods</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          {showForm ? 'Cancel' : 'Add Payment Method'}
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
                placeholder="My Visa"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Card Number</label>
              <input
                type="text"
                value={formData.cardNumber}
                onChange={(e) => setFormData({ ...formData, cardNumber: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="4111111111111111"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Expiry Month</label>
              <input
                type="text"
                value={formData.expiryMonth}
                onChange={(e) => setFormData({ ...formData, expiryMonth: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="MM"
                maxLength="2"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Expiry Year</label>
              <input
                type="text"
                value={formData.expiryYear}
                onChange={(e) => setFormData({ ...formData, expiryYear: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="YYYY"
                maxLength="4"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">CVV</label>
              <input
                type="text"
                value={formData.cvv}
                onChange={(e) => setFormData({ ...formData, cvv: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="123"
                maxLength="4"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Billing Address</label>
              <input
                type="text"
                value={formData.billingAddress1}
                onChange={(e) => setFormData({ ...formData, billingAddress1: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="123 Main St"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Address Line 2</label>
              <input
                type="text"
                value={formData.billingAddress2}
                onChange={(e) => setFormData({ ...formData, billingAddress2: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="Apt 4B"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">City</label>
              <input
                type="text"
                value={formData.billingCity}
                onChange={(e) => setFormData({ ...formData, billingCity: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="Los Angeles"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">State</label>
              <input
                type="text"
                value={formData.billingState}
                onChange={(e) => setFormData({ ...formData, billingState: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="CA"
                maxLength="2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">ZIP</label>
              <input
                type="text"
                value={formData.billingZip}
                onChange={(e) => setFormData({ ...formData, billingZip: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="90210"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Phone (Optional)</label>
              <input
                type="text"
                value={formData.billingPhone}
                onChange={(e) => setFormData({ ...formData, billingPhone: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="555-123-4567"
              />
            </div>
          </div>
          <button
            type="submit"
            className="w-full px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
          >
            Save Payment Method
          </button>
        </form>
      )}

      <div className="grid gap-4">
        {paymentMethods.map((method) => (
          <div
            key={method.id}
            className="bg-gray-800 p-4 rounded-lg flex justify-between items-center"
          >
            <div>
              <h3 className="font-bold text-lg">{method.name}</h3>
              <p className="text-sm text-gray-400">
                ****-****-****-{method.cardNumber.slice(-4)}
              </p>
              <p className="text-sm text-gray-400">
                Expires: {method.expiryMonth}/{method.expiryYear}
              </p>
              {method.billingAddress1 && (
                <p className="text-xs text-gray-500 mt-1">
                  {method.billingAddress1}, {method.billingCity}, {method.billingState}{' '}
                  {method.billingZip}
                </p>
              )}
            </div>
            <button
              onClick={() => handleDelete(method.id)}
              className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700"
            >
              Delete
            </button>
          </div>
        ))}
        {paymentMethods.length === 0 && !showForm && (
          <div className="text-center py-12">
            <p className="text-gray-400 mb-4">No payment methods yet.</p>
            <p className="text-sm text-gray-500">
              Add a payment method to use across multiple accounts
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

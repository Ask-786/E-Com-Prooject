const passport = require("passport");
const User = require("../models/User");
const mongoose = require("mongoose");
const Address = require("../models/Address");
const Cart = require("../models/Cart");
const Orders = require("../models/Orders");
const Product = require("../models/Product");
const Category = require("../models/Category");
const Favorites = require("../models/Favorites");
const querystring = require("querystring");
const moment = require("moment");
const { placeOrder } = require("../utils/place-order");
const { createOrderRz, verifyPayment } = require("../services/razorpay");
const initializePassport = require("../config/passport-config");
const { validateSignup } = require("../utils/joi-validation");
const { response } = require("express");
const { error } = require("console");
const Coupon = require("../models/Coupons");
const {
  ConnectionPolicyPage,
} = require("twilio/lib/rest/voice/v1/connectionPolicy");
const sendVerifyToken = require("../services/twilio").sendVerifyToken;
const checkVerificationToken =
  require("../services/twilio").checkVerificationToken;

initializePassport(passport);

const getHome = async (req, res) => {
  const category = await Category.find({});
  const product = await Product.find({})
    .populate("category")
    .sort({ updatedAt: -1 })
    .limit(12);
  res.render("user-views/home", {
    name: req.user,
    product,
    category,
  });
};

const getLogin = (req, res) => {
  res.render("user-views/login");
};

const getUserProfile = async (req, res) => {
  try {
    let Addresses = await Address.findOne({ user: req.user._id });
    res.render("user-views/profile", { user: req.user, address: Addresses });
  } catch {
    res.redirect("/home");
  }
};

const getAddAddress = (req, res) => {
  res.render("user-views/add-address");
};

const getDeleteAddress = async (req, res) => {
  try {
    await Address.updateOne(
      { user: req.user._id },
      {
        $pull: {
          Addressess: {
            _id: req.query.id,
          },
        },
      }
    );
    res.json({ status: true });
  } catch (err) {
    console.log(err.message);
  }
};

const getOtpVerify = (req, res) => {
  res.render("user-views/otp-verify");
};

const getSignUp = (req, res) => {
  res.render("user-views/signup", { message: req.flash("message") });
};

const getContact = (req, res) => {
  res.render("user-views/contact");
};

const getShop = async (req, res) => {
  try {
    const category = await Category.find({});
    const products = await Product.find({}).populate("category").limit(20);
    res.render("user-views/shop", {
      products,
      category,
    });
  } catch (err) {
    console.log(err.message);
  }
};

const getProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.query.id);
    res.render("user-views/product", {
      product,
    });
  } catch (err) {
    next(err);
  }
};

const getCart = async (req, res) => {
  try {
    let cart = await Cart.findOne({
      user: req.user._id,
      isexpired: false,
    })
      .populate({
        path: "bucket",
        populate: {
          path: "products",
        },
      })
      .populate("couponDetails");

    if (cart !== null && cart.bucket.length > 0) {
      if (
        cart.coupon === true &&
        cart.couponDetails.deductionType === "percentage"
      ) {
        const discount = (cart.grandtotal / 100) * cart.couponDetails.deduction;
        let total = cart.grandtotal - discount;
        res.render("user-views/cart", {
          message: req.flash("message"),
          cart,
          total,
          discount,
          grandtotal: cart.grandtotal,
          deduction: cart.couponDetails.deduction,
          type: "percentage",
        });
      } else if (
        cart.coupon === true &&
        cart.couponDetails.deductionType === "amount"
      ) {
        const discount = cart.couponDetails.deduction;
        let total = cart.grandtotal - discount;
        res.render("user-views/cart", {
          message: req.flash("message"),
          cart,
          total,
          grandtotal: cart.grandtotal,
          deduction: cart.couponDetails.deduction,
          discount,
          type: "amount",
        });
      } else {
        let total = cart.grandtotal;
        res.render("user-views/cart", {
          message: req.flash("message"),
          cart,
          total,
          grandtotal: cart.grandtotal,
        });
      }
    } else {
      res.render("user-views/empty-cart");
    }
  } catch (err) {
    console.log(err.message);
  }
};

const getAddToCart = async (req, res, next) => {
  try {
    let cartExists = await Cart.findOne({
      user: req.user._id,
      isexpired: false,
    });
    const product = await Product.findById(req.query.id);
    if (product.stock > 0) {
      if (cartExists === null) {
        await Cart.create({
          user: req.user._id,
          bucket: { products: req.query.id, subtotal: product.price },
          grandtotal: product.price,
        });
        res.json({ alert: true });
      } else {
        let itemExists = await Cart.exists({
          user: req.user._id,
          isexpired: false,
          "bucket.products": req.query.id,
        });
        if (itemExists === null) {
          let product = await Product.findById(req.query.id);
          await Cart.updateOne(
            { user: req.user._id, isexpired: false },
            {
              $push: {
                bucket: { products: req.query.id, subtotal: product.price },
              },
              $inc: {
                grandtotal: product.price,
              },
            }
          );
          res.json({ alert: true });
        } else {
          res.json({
            alert: false,
            message: "Item already exists in the cart",
          });
        }
      }
    } else {
      res.json({ alert: false, message: "No Stock" });
    }
  } catch (err) {
    next(err);
  }
};

const getCartItemIncrement = async (req, res, next) => {
  try {
    let id = mongoose.Types.ObjectId(req.query.id);
    let product = await Product.aggregate([
      { $match: { _id: id } },
      {
        $lookup: {
          from: "carts",
          let: { product: "$_id" },
          pipeline: [
            {
              $match: {
                user: req.user._id,
                isexpired: false,
              },
            },
          ],
          as: "userCart",
        },
      },
    ]);

    let userCartItem = product[0].userCart[0].bucket.find((elm) => {
      return elm.products.toString() === req.query.id;
    });

    if (product[0].stock > userCartItem.quantity) {
      await Cart.updateOne(
        {
          user: req.user._id,
          isexpired: false,
          "bucket.products": req.query.id,
        },
        {
          $inc: {
            "bucket.$.quantity": 1,
            "bucket.$.subtotal": product[0].price,
            grandtotal: product[0].price,
          },
        }
      );

      let cart = await Cart.findOne({
        user: req.user._id,
        isexpired: false,
        "bucket.products": req.query.id,
      }).populate("couponDetails");
      let cartItem = cart.bucket.find((elm) => {
        return elm.products.toString() === req.query.id;
      });

      if (
        cart.coupon === true &&
        cart.couponDetails.deductionType === "percentage"
      ) {
        const discount = (cart.grandtotal / 100) * cart.couponDetails.deduction;
        let total = cart.grandtotal - discount;
        res.json({
          count: cartItem.quantity,
          subtotal: cartItem.subtotal,
          grandtotal: cart.grandtotal,
          discount,
          deduction: cart.couponDetails.deduction,
          total,
          type: "percentage",
        });
      } else if (
        cart.coupon === true &&
        cart.couponDetails.deductionType === "amount"
      ) {
        const discount = cart.couponDetails.deduction;
        let total = cart.grandtotal - discount;
        res.json({
          count: cartItem.quantity,
          subtotal: cartItem.subtotal,
          grandtotal: cart.grandtotal,
          discount,
          total,
          deduction: cart.couponDetails.deduction,
          type: "amount",
        });
      } else {
        res.json({
          count: cartItem.quantity,
          subtotal: cartItem.subtotal,
          grandtotal: cart.grandtotal,
        });
      }
    } else {
      res.json({ noStock: true });
    }
  } catch (err) {
    next(err);
  }
};

const getCartItemDecrement = async (req, res) => {
  try {
    let product = await Product.findById(req.query.id);
    const preCart = await Cart.findOne({
      user: req.user._id,
      isexpired: false,
      "bucket.products": req.query.id,
    }).populate("couponDetails");

    if (
      preCart.coupon === true &&
      preCart.grandtotal - product.price < preCart.couponDetails.minAmount
    ) {
      return res.json({
        status: false,
        message:
          "Cant decrement the item lessthan the limited amount. else remove the coupon",
      });
    }

    const cart = await Cart.findOneAndUpdate(
      {
        user: req.user._id,
        isexpired: false,
        "bucket.products": req.query.id,
      },
      {
        $inc: {
          "bucket.$.quantity": -1,
          "bucket.$.subtotal": -product.price,
          grandtotal: -product.price,
        },
      },
      { new: true }
    ).populate("couponDetails");

    const cartItem = cart.bucket.find((elm) => {
      return elm.products.toString() === req.query.id;
    });

    if (
      cart.coupon === true &&
      cart.couponDetails.deductionType === "percentage"
    ) {
      const discount = (cart.grandtotal / 100) * cart.couponDetails.deduction;
      let total = cart.grandtotal - discount;
      res.json({
        status: true,
        count: cartItem.quantity,
        subtotal: cartItem.subtotal,
        grandtotal: cart.grandtotal,
        discount,
        deduction: cart.couponDetails.deduction,
        total,
        type: "percentage",
      });
    } else if (
      cart.coupon === true &&
      cart.couponDetails.deductionType === "amount"
    ) {
      const discount = cart.couponDetails.deduction;
      let total = cart.grandtotal - discount;
      res.json({
        status: true,
        count: cartItem.quantity,
        subtotal: cartItem.subtotal,
        grandtotal: cart.grandtotal,
        discount,
        total,
        type: "amount",
      });
    } else {
      res.json({
        status: true,
        count: cartItem.quantity,
        subtotal: cartItem.subtotal,
        grandtotal: cart.grandtotal,
      });
    }
  } catch (err) {
    res.json({ status: false, message: err.message });
  }
};

const getCartItemDelete = async (req, res, next) => {
  try {
    const cart = await Cart.findOne({
      user: req.user._id,
      isexpired: false,
    }).populate("couponDetails");

    let cartItem = cart.bucket.find((elm) => {
      return elm.products.toString() === req.query.id;
    });

    if (
      cart.coupon === true &&
      cart.grandtotal - cartItem.subtotal < cart.couponDetails.minAmount
    ) {
      return res.json({
        status: false,
        message:
          "Cant Delete the item less than the limited amount. else remove the coupon",
      });
    }

    await Cart.updateOne(
      {
        user: req.user._id,
        isexpired: false,
      },
      {
        $pull: {
          bucket: { products: req.query.id },
        },
        $inc: {
          grandtotal: -cartItem.subtotal,
        },
      }
    );

    let cartAfter = await Cart.findOne({
      user: req.user._id,
      isexpired: false,
    });

    res.json({
      grandtotal: cartAfter.grandtotal,
      status: true,
    });
  } catch (err) {
    res.json({
      status: false,
      message: err.message,
    });
  }
};

const getFavorites = async (req, res) => {
  try {
    let favorites = await Favorites.findOne({ user: req.user._id }).populate(
      "products"
    );
    if (favorites !== null && favorites.products.length > 0) {
      res.render("user-views/favorites", { products: favorites.products });
    } else {
      res.render("user-views/empty-favorites");
    }
  } catch (err) {
    console.log(err.message);
  }
};

const getAddToFavorites = async (req, res) => {
  try {
    let favoritesExists = await Favorites.exists({ user: req.user._id });

    if (favoritesExists === null) {
      await Favorites.create({
        user: req.user._id,
        products: req.query.id,
      });
      res.json({ status: true });
    } else {
      let itemExists = await Favorites.exists({
        user: req.user._id,
        products: req.query.id,
      });
      if (itemExists === null) {
        await Favorites.updateOne(
          { user: req.user._id },
          { $push: { products: req.query.id } }
        );
        res.json({ status: true });
      } else {
        res.json({ status: false });
      }
    }
  } catch (err) {
    console.log(err.message);
  }
};

const getFavoriteItemDelete = async (req, res) => {
  try {
    let favorites = await Favorites.findOne({ user: req.user._id });
    let favoriteItem = favorites.products.find((elm) => {
      return elm.toString() === req.query.id;
    });
    await Favorites.updateOne(
      { user: req.user._id },
      {
        $pull: { products: favoriteItem },
      }
    );
    res.json({ status: true });
  } catch (err) {
    console.log(err.message);
  }
};

const getCheckout = async (req, res, next) => {
  let userCart = await Cart.findOne({
    user: req.user._id,
    isexpired: false,
  })
    .populate("bucket.products")
    .populate("couponDetails");

  if (userCart !== null) {
    userCart.bucket.forEach((product) => {
      if (product.quantity > product.products.stock) {
        req.flash(
          "message",
          `${product.products.title} is not in stock right now`
        );
        return res.redirect("/cart");
      }
    });

    let userAddress = await Address.findOne({ user: req.user._id });

    if (
      userCart.coupon === true &&
      userCart.couponDetails.deductionType === "percentage"
    ) {
      const discount =
        (userCart.grandtotal / 100) * userCart.couponDetails.deduction;
      let total = userCart.grandtotal - discount;
      res.render("user-views/checkout", {
        cart: userCart,
        total,
        discount,
        grandtotal: userCart.grandtotal,
        deduction: userCart.couponDetails.deduction,
        type: "percentage",
        address: userAddress,
      });
    } else if (
      userCart.coupon === true &&
      userCart.couponDetails.deductionType === "amount"
    ) {
      const discount = userCart.couponDetails.deduction;
      let total = userCart.grandtotal - discount;
      res.render("user-views/checkout", {
        cart: userCart,
        total,
        grandtotal: userCart.grandtotal,
        deduction: userCart.couponDetails.deduction,
        discount,
        type: "amount",
        address: userAddress,
      });
    } else {
      let total = userCart.grandtotal;
      res.render("user-views/checkout", {
        cart: userCart,
        total,
        grandtotal: userCart.grandtotal,
        address: userAddress,
      });
    }
  } else {
    res.redirect("/cart");
  }
};

const postVerifyCoupon = async (req, res, next) => {
  const cart = await Cart.findOne({ user: req.user._id, isexpired: false });
  const coupon = await Coupon.findOne({ couponCode: req.body.couponCode });
  if (coupon !== null) {
    const userCheck = coupon.users.includes(req.user._id);
    const expr = moment(coupon.expiryDate).format();
    const now = moment(Date.now()).format();
    if (coupon.diactivated === true) {
      res.json({
        status: false,
        message: "This coupon was removed by admins for some reason",
      });
    } else if (now > expr) {
      res.json({
        status: false,
        message: "This coupon is expired",
      });
    } else if (userCheck === true) {
      res.json({
        status: false,
        message: "You have already availed this coupon",
      });
    } else if (coupon.minAmount > cart.grandtotal) {
      res.json({
        status: false,
        message: `This coupon is applicable only for purchases above $ ${coupon.minAmount}`,
      });
    } else {
      const cart = await Cart.findOneAndUpdate(
        {
          user: req.user._id,
          isexpired: false,
        },
        { coupon: true, couponDetails: coupon._id },
        { new: true }
      ).populate("couponDetails");
      coupon.users.push(req.user._id);
      await coupon.save();

      if (coupon.deductionType === "percentage") {
        const discount = (cart.grandtotal / 100) * coupon.deduction;
        const total = cart.grandtotal - discount;
        res.json({
          status: true,
          total,
          discount,
          type: "percentage",
          deduction: coupon.deduction,
        });
      } else {
        const discount = coupon.deduction;
        const total = cart.grandtotal - discount;
        res.json({
          status: true,
          total,
          discount,
          type: "amount",
          deduction: coupon.deduction,
        });
      }
    }
  } else {
    console.log("hello");
    res.json({ status: false, message: "There is no such coupon!!" });
  }
};

const getOrderConfirmation = async (req, res, next) => {
  const preOrder = await Orders.findById(req.query.id).populate("cart");
  const preOrder1 = await Coupon.populate(preOrder, {
    path: "cart.couponDetails",
  });
  const order = await Product.populate(preOrder1, {
    path: "cart.bucket.products",
  });
  res.render("user-views/order-confirm", { order, user: req.user });
};

const getOrders = async (req, res, next) => {
  const preOrders = await Orders.find({ user: req.user._id })
    .populate("cart")
    .sort({ updatedAt: -1 });
  const preOrders1 = await Coupon.populate(preOrders, {
    path: "cart.couponDetails",
  });
  const orders = await Product.populate(preOrders1, {
    path: "cart.bucket.products",
  });
  const formatedOrders = orders.map((el) => {
    let newEl = { ...el._doc };
    newEl.createdAt = moment(newEl.createdAt).format("LL");
    return newEl;
  });
  if (formatedOrders.length > 0) {
    res.render("user-views/orders", {
      orders: formatedOrders,
      message: req.flash("message"),
    });
  } else {
    res.render("user-views/empty-orders");
  }
};

const postCheckout = async (req, res, next) => {
  try {
    const cart = await Cart.findById(req.body.cartId).populate("couponDetails");
    if (
      cart.coupon === true &&
      cart.couponDetails.deductionType === "percentage"
    ) {
      if (req.body.payType === "Cash on Delivery") {
        const Addressess = await Address.findOne({ user: req.user._id });
        const address = Addressess.Addressess.find((elm) => {
          return elm._id.toString() === req.body.address;
        });
        placeOrder(
          req.user._id,
          req.body.cartId,
          address,
          req.body.payType,
          "pending",
          "",
          cart.grandtotal -
            (cart.grandtotal / 100) * cart.couponDetails.deduction
        ).then((order) => {
          res.json({ order, codStatus: true });
        });
      } else if (req.body.payType === "Razor Pay") {
        const amount =
          cart.grandtotal -
          (cart.grandtotal / 100) * cart.couponDetails.deduction;
        createOrderRz(amount, req.body.cartId)
          .then((val) => {
            res.json({
              rzSuccess: true,
              order: val,
              keyId: process.env.RAZORPAY_KEY_ID,
              user: req.user,
              address: req.body.address,
              payType: req.body.payType,
            });
          })
          .catch((err) => {
            res.json({
              rzError: true,
              message: err.error,
            });
          });
      }
    } else if (
      cart.coupon === true &&
      cart.couponDetails.deductionType === "amount"
    ) {
      if (req.body.payType === "Cash on Delivery") {
        const Addressess = await Address.findOne({ user: req.user._id });
        const address = Addressess.Addressess.find((elm) => {
          return elm._id.toString() === req.body.address;
        });
        placeOrder(
          req.user._id,
          req.body.cartId,
          address,
          req.body.payType,
          "pending",
          "",
          cart.grandtotal - cart.couponDetails.deduction
        ).then((order) => {
          res.json({ order, codStatus: true });
        });
      } else if (req.body.payType === "Razor Pay") {
        const amount = cart.grandtotal - cart.couponDetails.deduction;
        createOrderRz(amount, req.body.cartId)
          .then((val) => {
            res.json({
              rzSuccess: true,
              order: val,
              keyId: process.env.RAZORPAY_KEY_ID,
              user: req.user,
              address: req.body.address,
              payType: req.body.payType,
            });
          })
          .catch((err) => {
            res.json({
              rzError: true,
              message: err.error,
            });
          });
      }
    } else {
      if (req.body.payType === "Cash on Delivery") {
        const Addressess = await Address.findOne({ user: req.user._id });
        const address = Addressess.Addressess.find((elm) => {
          return elm._id.toString() === req.body.address;
        });
        placeOrder(
          req.user._id,
          req.body.cartId,
          address,
          req.body.payType,
          "pending",
          "",
          cart.grandtotal
        ).then((order) => {
          res.json({ order, codStatus: true });
        });
      } else if (req.body.payType === "Razor Pay") {
        createOrderRz(cart.grandtotal, req.body.cartId)
          .then((val) => {
            res.json({
              rzSuccess: true,
              order: val,
              keyId: process.env.RAZORPAY_KEY_ID,
              user: req.user,
              address: req.body.address,
              payType: req.body.payType,
            });
          })
          .catch((err) => {
            res.json({
              rzError: true,
              message: err.error,
            });
          });
      }
    }
  } catch (err) {
    next(err);
  }
};

const postAddAddress = async (req, res) => {
  try {
    let addressExists = await Address.exists({ user: req.user._id });
    if (addressExists === null) {
      await Address.create({
        user: req.user._id,
        Addressess: req.body,
      });
      res.redirect("/userprofile");
    } else {
      await Address.updateOne(
        { user: req.user._id },
        {
          $push: { Addressess: req.body },
        }
      );
      res.redirect("/userprofile");
    }
  } catch (err) {
    console.log(err.message);
  }
};

const postSignUp = async (req, res) => {
  const { error, value } = validateSignup(req.body);
  if (error) {
    req.flash("message", error.message);
    res.redirect("/signup");
  } else {
    try {
      const tempUser = await User.exists({
        $or: [
          { username: req.body.name },
          { email: req.body.email },
          { phone: req.body.phone },
        ],
      });
      if (tempUser === null) {
        req.session.temp = req.body;
        sendVerifyToken(req.body.phone).then(() => {
          res.redirect("/otp-verify");
        });
      } else {
        req.flash(
          "message",
          "User Already Exists (Username, Email or Phone is Already Registered)"
        );
        res.redirect("/signup");
      }
    } catch (err) {
      req.flash("message", "Something went wrong");
      res.redirect("/signup");
    }
  }
};

const postLogin = passport.authenticate("local", {
  successRedirect: "/",
  failureRedirect: "/login",
  failureFlash: true,
});

const postOtpVerify = (req, res) => {
  try {
    checkVerificationToken(req.session.temp.phone, req.body.otp).then(
      (status) => {
        if (status === "approved") {
          User.create(req.session.temp).then(() => {
            req.logOut((err) => {
              res.redirect("/login");
            });
          });
        } else {
          req.logOut((err) => {
            const query = querystring.stringify({
              errMessage: "Wrong OTP",
            });
            res.redirect("/signup");
          });
        }
      }
    );
  } catch (err) {
    console.log(err.message);
  }
};

const postVerifyPayment = async (req, res, next) => {
  verifyPayment(req.body.response).then(async (response) => {
    if (response) {
      const cartId = req.body.order.receipt;
      const cart = await Cart.findById(cartId).populate("couponDetails");
      const Addressess = await Address.findOne({ user: req.user._id });
      const address = Addressess.Addressess.find((elm) => {
        return elm._id.toString() === req.body.addressId;
      });
      if (
        cart.coupon === true &&
        cart.couponDetails.deductionType === "percentage"
      ) {
        placeOrder(
          req.user._id,
          cartId,
          address,
          req.body.payType,
          "success",
          req.body.response.razorpay_payment_id,
          cart.grandtotal -
            (cart.grandtotal / 100) * cart.couponDetails.deduction
        ).then((order) => {
          res.json({ order, rzStatus: true });
        });
      } else if (
        cart.coupon === true &&
        cart.couponDetails.deductionType === "amount"
      ) {
        placeOrder(
          req.user._id,
          cartId,
          address,
          req.body.payType,
          "success",
          req.body.response.razorpay_payment_id,
          cart.grandtotal - cart.couponDetails.deduction
        ).then((order) => {
          res.json({ order, rzStatus: true });
        });
      } else {
        placeOrder(
          req.user._id,
          cartId,
          address,
          req.body.payType,
          "success",
          req.body.response.razorpay_payment_id,
          cart.grandtotal
        ).then((order) => {
          res.json({ order, rzStatus: true });
        });
      }
    } else {
      res.json({ rzStatus: false });
    }
  });
};

// const postLogin = (req, res) => {
//   try {
//     User.findOne(
//       {
//         $or: [{ username: req.body.username }, { email: req.body.username }],
//       },
//       (err, user) => {
//         if (user !== null) {
//           if (err) {
//             console.log(err);
//           } else {
//             user.comparePasswords(req.body.password, (err, isMatch) => {
//               console.log(isMatch);
//               if (err) {
//                 res.redirect("/login");
//               } else {
//                 if (isMatch) {
//                   res.redirect("/");
//                 } else {
//                   res.redirect("/login");
//                 }
//               }
//             });
//           }
//         } else {
//           res.redirect("/login");
//         }
//       }
//     );
//   } catch (err) {
//     res.redirect("/login");
//   }
// };

const patchCancelOrder = async (req, res, next) => {
  await Orders.updateOne(
    { _id: req.body.orderId },
    { orderStatus: "cancelled" }
  );
  req.flash("message", "Order Cancelled Successfully");
  res.json({ status: true, orderStatus: "cancelled" });
};

const patchRemoveCoupon = async (req, res, next) => {
  try {
    const cart = await Cart.findOne({
      user: req.user._id,
      isexpired: false,
    }).populate("couponDetails");
    const coupon = await Coupon.findById(cart.couponDetails._id);
    const userIndex = coupon.users.indexOf(
      mongoose.Types.ObjectId(req.user._id)
    );

    if (userIndex !== -1) {
      coupon.users.splice(userIndex, 1);
    }

    cart.coupon = false;
    cart.couponDetails = null;

    await cart.save();
    await coupon.save();

    res.json({ removeStatus: true });
  } catch (err) {
    res.json({ removeStatus: false, message: err.message });
  }
};

const deleteLogout = (req, res) => {
  req.logOut((err) => {
    console.log("logged out");
    res.redirect("/");
  });
};

module.exports = {
  getHome,
  getLogin,
  postLogin,
  getSignUp,
  postSignUp,
  getCart,
  getContact,
  getShop,
  getProduct,
  deleteLogout,
  getOtpVerify,
  postOtpVerify,
  getAddToCart,
  getCartItemIncrement,
  getCartItemDecrement,
  getCartItemDelete,
  getFavorites,
  getAddToFavorites,
  getFavoriteItemDelete,
  getUserProfile,
  getAddAddress,
  postAddAddress,
  getDeleteAddress,
  getCheckout,
  postCheckout,
  getOrderConfirmation,
  getOrders,
  postVerifyPayment,
  patchCancelOrder,
  postVerifyCoupon,
  patchRemoveCoupon,
};
